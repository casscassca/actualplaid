const util = require("util");
const { Configuration, PlaidEnvironments, PlaidApi } = require("plaid");
const path = require("path");
const Fastify = require("fastify");
const fastifyStatic = require("@fastify/static");
const opn = require("better-opn");
const dateFns = require("date-fns");
const inquirer = require("inquirer");
const terminalLink = require("terminal-link");
const { getAppConfigFromEnv, getConf } = require("./config.js");
const { initialize, getLastTransactionDate, importPlaidTransactions, listAccounts, finalize, getBalance } = require("./actual.js");

const fastify = Fastify({
    logger: {
        level: "error"
    }
});

let config;
const appConfig = getAppConfigFromEnv()
const configuration = new Configuration({
    basePath: PlaidEnvironments[appConfig.PLAID_ENV],
    baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': appConfig.PLAID_CLIENT_ID,
          'PLAID-SECRET': appConfig.PLAID_SECRETS[appConfig.PLAID_ENV]
        }
    }
});
const plaidClient = new PlaidApi(configuration);

// Drives what the browser flow does: link a brand new bank, or re-authenticate
// an existing one (Plaid "update mode") without consuming another Item.
let linkSession = { mode: "create" };

fastify.register(fastifyStatic, {
    root: path.join(__dirname, "public"),
    prefix: "/public/",
});

const startFastifyServer = async () => {
    await fastify.listen({ port: appConfig.APP_PORT, host: appConfig.APP_BIND_ADDRESS });
};

const getLinkUrl = () =>
    appConfig.APP_URL === "http://localhost"
        ? `http://localhost:${appConfig.APP_PORT}`
        : appConfig.APP_URL;

const plaidErrorCode = (e) => e?.response?.data?.error_code;

const isLoginRequired = (e) => plaidErrorCode(e) === "ITEM_LOGIN_REQUIRED";

const reauthHint = (bankName) =>
    `${bankName} needs to be re-authenticated. Run \`actualplaid update "${bankName}"\` to repair the connection.`;

const printSyncedAccounts = () => {
    const actualData = config.get("actualSync");
    const plaidData = config.get("plaidAccounts");
    if (!actualData) {
        console.log("No syncing data found");
        return;
    }

    console.log("The following accounts are linked to Actual:");
    console.table(
        Object.values(actualData).map((account) => ({
            "Actual Account": account.actualName,
            "Actual Type": account.actualType,
            "Plaid Bank": account.plaidBankName,
            "Plaid Account": account.plaidAccount.name,
            "Plaid Type": `${account.plaidAccount.subtype}/${account.plaidAccount.type}`,
            "Plaid Account #": account.plaidAccount.mask,
        }))
    );

    const linkedToActual = Object.entries(actualData).map(
        ([actualId, { plaidAccount }]) => { return { plaid: plaidAccount.account_id, actual: actualId } }
    )

    linkedToActual.forEach((ids) => {
        delete plaidData[ids.plaid];
    });

    console.log("The following Plaid accounts are linked to this app, but not to Actual:");
    console.table(
        Object.values(plaidData).map(({ account, plaidBankName }) => ({
            "Bank": plaidBankName,
            "Account": account.name,
            "Type": `${account.subtype}/${account.type}`,
            "Account #": account.mask,
        }))
    );
};

/**
 * Every distinct Plaid Item (access token) this config knows about, gathered
 * from both linked-but-unused accounts and accounts already synced to Actual.
 */
const getLinkedItems = () => {
    const items = new Map();

    const record = (plaidToken, plaidItemId, plaidBankName, accountName) => {
        if (!plaidToken) return;
        const item = items.get(plaidToken) || {
            plaidToken,
            plaidItemId,
            plaidBankName: plaidBankName || "Unknown bank",
            accountNames: [],
        };
        if (accountName && !item.accountNames.includes(accountName)) {
            item.accountNames.push(accountName);
        }
        items.set(plaidToken, item);
    };

    Object.values(config.get("plaidAccounts") || {}).forEach(
        ({ account, plaidToken, plaidItemId, plaidBankName }) =>
            record(plaidToken, plaidItemId, plaidBankName, account?.name)
    );
    Object.values(config.get("actualSync") || {}).forEach(
        ({ plaidAccount, plaidToken, plaidItemId, plaidBankName }) =>
            record(plaidToken, plaidItemId, plaidBankName, plaidAccount?.name)
    );

    return [...items.values()];
};

const getItemHealth = async (item) => {
    try {
        const response = await plaidClient.itemGet({ access_token: item.plaidToken });
        return response.data.item.error?.error_code || null;
    } catch (e) {
        return plaidErrorCode(e) || "UNKNOWN_ERROR";
    }
};

const describeItem = (item, errorCode) =>
    [
        item.plaidBankName,
        item.accountNames.length ? `(${item.accountNames.join(", ")})` : null,
        errorCode ? `- ${errorCode}` : "- OK",
    ]
        .filter(Boolean)
        .join(" ");

/**
 * Re-authenticates an existing Item through Plaid Link's update mode. The
 * access token stays valid afterwards, so no new Item is consumed.
 */
async function runUpdateModeLink(item) {
    linkSession = {
        mode: "update",
        accessToken: item.plaidToken,
        bankName: item.plaidBankName,
    };
    const completed = new Promise((resolve) => {
        linkSession.onComplete = resolve;
    });

    await startFastifyServer();

    const linkUrl = getLinkUrl();
    console.log(
        `Repairing the existing connection to ${item.plaidBankName}. This reuses the same Plaid Item, so it will not use up one of your Plaid Item slots.`
    );
    if (appConfig.APP_URL === "http://localhost") {
        console.log(`Opening ${linkUrl} to re-authenticate...`);
        opn(linkUrl);
    } else {
        console.log(`Open ${linkUrl} in a browser to re-authenticate...`);
    }
    console.log("Waiting for you to finish in the browser (Ctrl+C to cancel)...");

    await completed;
}

async function startLinkingPlaid() {
    const { dissmissedWarning } = await inquirer.prompt({
        type: "confirm",
        name: "dissmissedWarning",
        message: `WARNING: A Plaid Dev account has a limited number of Links. See the ${terminalLink(
            "Plaid Development Dashboard",
            "https://dashboard.plaid.com/overview/development"
        )} to check your usage. Proceed?`,
    });
    if (!dissmissedWarning) {
        throw new Error("Plaid Linking cancelled");
    }
    startFastifyServer();

    const { confirm } = await inquirer.prompt({
        type: "confirm",
        name: "confirm",
        message: `Please link each bank you expect to sync with Actual, using the URL to follow. Proceed?`,
    });

    if (!confirm) {
        throw new Error("Plaid Linking cancelled");
    }

    if (`${appConfig.APP_URL}` == 'http://localhost') {
        const plaidLinkLink = `http://localhost:${appConfig.APP_PORT}`;
        console.log(
            `Opening ${plaidLinkLink} to link with Plaid...\nNOTE: Please return to your CLI when completed.`
        );
        opn(plaidLinkLink);
    } else {
        const plaidLinkLink = `${appConfig.APP_URL}`;
        console.log(
            `Open ${plaidLinkLink} to link with Plaid in a browser...\nNOTE: Please return to your CLI when completed.`
        );
    }

    let doneLinking = false;

    while (!doneLinking) {
        let result = await inquirer.prompt({
            type: "confirm",
            name: "doneLinking",
            message: `Are you done linking banks?`,
        });
        doneLinking = result.doneLinking;
    }

    const plaidAccounts = config.get("plaidAccounts");
    if (!plaidAccounts) {
        throw new Error("You did not link any Plaid accounts");
    }
    return plaidAccounts
}


/**
 * 
 * @param {string} command 
 * @param {object} flags 
 * @param {string} flags.account
 * @param {string} flags.since
 * @param {string} [target] extra positional input, ex: the bank to update
 */
module.exports = async (command, flags, target) => {
    if (!command) {
        console.log('Try "actualplaid --help"');
        process.exit();
    }

    config = getConf(flags.user || "default")

    if (command === "config") {
        console.log(`Config for this app is located at: ${config.path}`);
    } else if (command === "import") {
        const syncingData = config.get(`actualSync`) || {};

        if (Object.keys(syncingData).length) {
            const actual = await initialize(config);
            const accountsToSync = Object.entries(syncingData).filter(
                ([_, account]) =>
                    !flags.account || account.actualName === flags.account
            );

            const endDate = dateFns.format(new Date(), "yyyy-MM-dd");

            const transactionsPerToken = {};

            const cachedTransaction = async (token, startDate) => {
                const key = `${token}-${startDate.toString()}`;
                if (!transactionsPerToken[key]) {
                    transactionsPerToken[key] = await plaidClient.transactionsGet({
                        access_token: token,
                        start_date: startDate,
                        end_date: endDate
                    });
                }
                return transactionsPerToken[key];
            }

            const needsReauth = new Set();

            for (let [actualId, account] of accountsToSync) {
                if (needsReauth.has(account.plaidBankName)) {
                    continue;
                }

                const startDate = dateFns.format(
                    new Date(
                        flags["since"] ||
                        account.lastImport ||
                        await getLastTransactionDate(actual, actualId)
                    ),
                    "yyyy-MM-dd"
                );

                const isInvestment = account.plaidAccount.type === 'investment';

                if (startDate === endDate && !isInvestment) {
                    console.log("Skipping: ", account.plaidAccount.name, "because it was already imported today")
                } else {
                    console.log("Importing transactions for account: ", account.plaidAccount.name, "from ", startDate, "to", endDate)

                    try {
                        let plaidBalance = null;
                        try {
                            const balanceResponse = await plaidClient.accountsBalanceGet({
                                access_token: account.plaidToken,
                                options: {
                                    account_ids: [account.plaidAccount.account_id],
                                }
                            });
                            const rawBalance = balanceResponse.data.accounts[0]?.balances.current;
                            plaidBalance = rawBalance != null ? Math.round(rawBalance * 100) : null;
                        } catch (e) {
                            if (isLoginRequired(e)) throw e;
                            console.warn("Could not fetch Plaid balance for", account.plaidAccount.name, "- skipping balance update:", e.message);
                        }

                        if (!isInvestment) {
                            const tempStartTime = new Date();
                            const transactionsResponse = await cachedTransaction(account.plaidToken, startDate);
                            const transactionsForThisAccount = transactionsResponse.data.transactions.filter(
                                (transaction) =>
                                    transaction.account_id === account.plaidAccount.account_id
                            );
                            const timeTookForPlaid = new Date() - tempStartTime;
                            const timeToSleep = 2000 - timeTookForPlaid;
                            if (timeToSleep > 0) {
                                await new Promise((resolve) => setTimeout(resolve, timeToSleep));
                            }
                            await importPlaidTransactions(actual, actualId, account.plaidBankName, transactionsForThisAccount, plaidBalance);
                        } else {
                            await importPlaidTransactions(actual, actualId, account.plaidBankName, [], plaidBalance);
                        }

                        config.set(`actualSync.${actualId}.lastImport`, new Date());
                    } catch (e) {
                        if (!isLoginRequired(e)) throw e;
                        needsReauth.add(account.plaidBankName);
                        console.warn(`Skipping ${account.plaidBankName}: ${reauthHint(account.plaidBankName)}`);
                    }
                }
            }

            if (needsReauth.size) {
                console.log(`Import finished, but these banks were skipped and need re-authentication: ${[...needsReauth].join(", ")}`);
            } else {
                console.log("Import completed for all accounts");
            }

            await finalize(actual)
        } else {
            throw new Error("No syncing data found please run `actualplaid setup`");
        }

    } else if (command === "setup") {
        let plaidAccounts = config.get("plaidAccounts") || {};

        const linkedToActual = Object.entries(config.get("actualSync") || {}).map(
            ([actualId, { plaidAccount }]) => { return { plaid: plaidAccount.account_id, actual: actualId } }
        )

        linkedToActual.forEach((ids) => {
            delete plaidAccounts[ids.plaid];
        });

        if (Object.keys(plaidAccounts).length == 0) {
            console.log("There are no accounts linked to Plaid that are not already in Actual. Please link at least one new account to continue.")
            plaidAccounts = await startLinkingPlaid();
        } else {
            console.log("The following accounts are linked to Plaid, but not to Actual:");
            console.table(
                Object.values(plaidAccounts).map(({ account, plaidBankName }) => ({
                    "Bank": plaidBankName,
                    "Account": account.name,
                    "Type": `${account.subtype}/${account.type}`,
                    "Account #": account.mask,
                }))
            );
            const { confirm } = await inquirer.prompt({
                type: "confirm",
                name: "confirm",
                message: `Do you want to re-link your accounts or add extra?`,
                default: false,
            });

            if (confirm) {
                plaidAccounts = await startLinkingPlaid();
            }
        }

        linkedToActual.forEach((ids) => {
            delete plaidAccounts[ids.plaid];
        });

        console.log("The following accounts will be used to link to actual:");
        console.table(
            Object.values(plaidAccounts).map(({ account, plaidBankName }) => ({
                "Bank": plaidBankName,
                "Account": account.name,
                "Type": `${account.subtype}/${account.type}`,
                "Account #": account.mask,
            }))
        );

        const accountsInTheActualBudget = await listAccounts(await initialize(config));
        const { accountsToSync } = await inquirer.prompt({
            type: "checkbox",
            name: "accountsToSync",
            message: `Which actual accounts do you want to sync with plaid?`,
            choices: accountsInTheActualBudget.map(({ name, id }) => ({ name, value: id })).filter(({ value }) => !linkedToActual.find(({ actual }) => actual === value)),
        });

        for (acctId of accountsToSync) {
            const actualAcct = accountsInTheActualBudget.find((a) => a.id === acctId);
            let syncChoices = Object.values(plaidAccounts).map(
                ({ account, plaidBankName }) => ({
                    value: account.account_id,
                    name: `${plaidBankName}: ${account.name} - ${account.subtype}/${account.type} (${account.mask})`,
                })
            );
            const { plaidAccountIDToSync } = await inquirer.prompt({
                type: "list",
                name: "plaidAccountIDToSync",
                message: `Which Plaid acount do you want to sync with "${actualAcct.name}"?`,
                choices: syncChoices,
            });
            const plaidAccountToSync = Object.values(plaidAccounts).find(
                ({ account }) => account.account_id === plaidAccountIDToSync
            );

            delete plaidAccounts[plaidAccountIDToSync]

            config.set(`actualSync.${acctId}`, {
                actualName: actualAcct.name,
                actualType: actualAcct.type,
                actualAccountId: actualAcct.id,
                plaidItemId: plaidAccountToSync.plaidItemId,
                plaidToken: plaidAccountToSync.plaidToken,
                plaidAccount: plaidAccountToSync.account,
                plaidBankName: plaidAccountToSync.plaidBankName,
            });
        }
        printSyncedAccounts();
        console.log(
            `Setup completed sucessfully. Run \`actualplaid import\` to sync your setup banks with their respective actual accounts`
        );

    } else if (command == "check") {
        const actual = await initialize(config);
        const syncingData = config.get(`actualSync`) || {};

        if (Object.keys(syncingData).length == 0) {
            console.log("No syncing data found please run `actualplaid setup`");
        }

        for (let [actualId, account] of Object.entries(syncingData)) {
            const balanceFromActual = await getBalance(actual, actualId);
            let plaidBalanceInformation;
            try {
                plaidBalanceInformation = await plaidClient.accountsBalanceGet({
                    access_token: account.plaidToken,
                    options: {
                        account_ids: [account.plaidAccount.account_id],
                    }
                });
            } catch (e) {
                if (!isLoginRequired(e)) throw e;
                console.warn(`Skipping ${account.actualName}: ${reauthHint(account.plaidBankName)}`);
                continue;
            }

            const balanceFromPlaid = plaidBalanceInformation.data.accounts[0].balances.current
            const actualConverted = actual.utils.integerToAmount(balanceFromActual);

            console.log(`Checking balance for account: ${account.actualName} (${account.plaidBankName})`)
            console.log("Actual balance: ", actualConverted)
            console.log("Plaid balance: ", balanceFromPlaid)

            if (actualConverted !== balanceFromPlaid) {
                throw new Error(`Balance for account ${account.actualName} (${account.plaidBankName}) does not match. Actual: ${balanceFromActual} Plaid: ${balanceFromPlaid}`)
            }
        }

    } else if (command === "status") {
        const items = getLinkedItems();
        if (!items.length) {
            console.log("No Plaid connections found. Run `actualplaid setup` first.");
        } else {
            console.log("Checking the status of your Plaid connections...");
            const rows = [];
            for (const item of items) {
                const errorCode = await getItemHealth(item);
                rows.push({
                    "Bank": item.plaidBankName,
                    "Accounts": item.accountNames.join(", "),
                    "Status": errorCode || "OK",
                });
            }
            console.table(rows);

            const broken = rows.filter((row) => row.Status !== "OK");
            broken.forEach((row) => console.log(reauthHint(row.Bank)));
        }

    } else if (command === "update") {
        const items = getLinkedItems();
        if (!items.length) {
            throw new Error("No Plaid connections found. Run `actualplaid setup` first.");
        }

        let matches = items;
        if (target) {
            matches = items.filter((item) =>
                item.plaidBankName.toLowerCase().includes(target.toLowerCase())
            );
            if (!matches.length) {
                throw new Error(
                    `No linked bank matches "${target}". Linked banks: ${items.map((item) => item.plaidBankName).join(", ")}`
                );
            }
        }

        let item = matches[0];
        if (matches.length > 1) {
            console.log("Checking the status of your Plaid connections...");
            const choices = [];
            for (const candidate of matches) {
                const errorCode = await getItemHealth(candidate);
                choices.push({
                    name: describeItem(candidate, errorCode),
                    value: candidate.plaidToken,
                });
            }
            const { plaidToken } = await inquirer.prompt({
                type: "list",
                name: "plaidToken",
                message: "Which bank connection do you want to repair?",
                choices,
            });
            item = matches.find((candidate) => candidate.plaidToken === plaidToken);
        }

        await runUpdateModeLink(item);

    } else if (command === "ls") {
        printSyncedAccounts();
    }
    process.exit();
};

fastify.get("/", (req, reply) => reply.sendFile("index.html"));

fastify.post("/create_link_token", async (request, reply) => {
    const appConfig = getAppConfigFromEnv()
    const isUpdate = linkSession.mode === "update";

    const configs = {
        user: { client_user_id: config.get("user") },
        client_name: "Actual Budget Plaid Importer",
        country_codes: appConfig.PLAID_COUNTRY_CODES,
        language: appConfig.PLAID_LANGUAGE
    };

    if (isUpdate) {
        // Passing an access token is what puts Link into update mode; Plaid
        // requires the products array to be left off in that case.
        configs.access_token = linkSession.accessToken;
    } else {
        configs.products = appConfig.PLAID_PRODUCTS;
    }

    try {
        const response = await plaidClient.linkTokenCreate(configs);
        reply.send({
            link_token: response.data.link_token,
            mode: linkSession.mode,
            bank_name: isUpdate ? linkSession.bankName : null,
        });
    } catch (e) {
        console.error("ERR when creating link token", e.response?.data || e);
        reply.code(500).send({ error: "Could not create a Plaid link token" });
    }
});

/**
 * Stores the current accounts for an Item, and points any account already
 * synced to Actual at the refreshed Plaid metadata.
 */
const storeItemAccounts = async (access_token, fallbackName) => {
    const appConfig = getAppConfigFromEnv()

    const accountResponse = await plaidClient.accountsGet({ access_token });
    const accounts = accountResponse.data.accounts;
    const item_id = accountResponse.data.item.item_id;
    const institution_id = accountResponse.data.item.institution_id;

    // The lookup fails when PLAID_COUNTRY_CODES omits the institution's country,
    // which should not be enough to lose an otherwise successful link.
    let name = fallbackName || institution_id;
    try {
        const institutionResponse = await plaidClient.institutionsGetById({
            institution_id: institution_id,
            country_codes: appConfig.PLAID_COUNTRY_CODES
        });
        name = institutionResponse.data.institution.name;
    } catch (e) {
        console.warn(
            `Could not look up institution ${institution_id} with country codes ${appConfig.PLAID_COUNTRY_CODES.join(",")}, using "${name}":`,
            plaidErrorCode(e) || e.message
        );
    }

    accounts.forEach((account) => {
        config.set(`plaidAccounts.${account.account_id}`, {
            account,
            plaidToken: access_token,
            plaidItemId: item_id,
            plaidBankName: name,
            plaidInstitutionId: institution_id,
        });
    });

    Object.entries(config.get("actualSync") || {}).forEach(([actualId, synced]) => {
        if (synced.plaidToken !== access_token) return;
        const account = accounts.find(
            (candidate) => candidate.account_id === synced.plaidAccount.account_id
        );
        if (account) {
            config.set(`actualSync.${actualId}.plaidAccount`, account);
        } else {
            console.warn(
                `"${synced.plaidAccount.name}" is no longer shared by ${name}. Re-run update and select it, or re-run setup.`
            );
        }
    });

    return { accounts, name };
};

fastify.post("/get_access_token", async (request, reply) => {
    console.log("Received new request to link accounts")
    const body = JSON.parse(request.body);

    try {
        const tokenResponse = await plaidClient.itemPublicTokenExchange({ public_token: body.public_token });
        const access_token = tokenResponse.data.access_token;

        const { accounts, name } = await storeItemAccounts(access_token);
        accounts.forEach(() => console.log("Linked new account: ", name));
        reply.send({ ok: true });

    } catch (e) {
        console.error("ERR when linking tokens", e)
        reply.code(500).send({ ok: false });
    }
});

fastify.post("/complete_update", async (request, reply) => {
    if (linkSession.mode !== "update") {
        reply.code(400).send({ ok: false, error: "No update session in progress" });
        return;
    }

    try {
        const { accounts, name } = await storeItemAccounts(linkSession.accessToken, linkSession.bankName);
        reply.send({ ok: true });
        console.log(`Re-authenticated ${name}. ${accounts.length} account(s) are still shared with this app.`);
        console.log("The existing access token is unchanged, so no additional Plaid Item was used.");

        // The CLI exits as soon as this resolves, so wait until the browser has
        // actually received the response.
        const onComplete = linkSession.onComplete;
        if (reply.raw.writableEnded) {
            onComplete();
        } else {
            reply.raw.on("finish", onComplete);
        }
    } catch (e) {
        console.error("ERR when refreshing item after update", e)
        reply.code(500).send({ ok: false });
    }
});
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const actual = require('@actual-app/api');

// ====== CONFIG ======
// One entry per Questrade login. envKey holds the INITIAL refresh token (seed).
// After the first run, the rotated token lives in tokenFile and the env var is no longer used
// (unless the stored token stops working, in which case the env seed is retried).
const QUESTRADE_USERS = [
    {
        name: 'Cass',
        envKey: 'CASS_QUESTRADE',
        tokenFile: path.join(__dirname, 'questrade-token-cass.json'),
        accounts: { '0243': 'CAD Cass RSP' }, // last 4 of Questrade account # -> Actual account name
    },
    {
        name: 'Jason',
        envKey: 'JASON_QUESTRADE',
        tokenFile: path.join(__dirname, 'questrade-token-jason.json'),
        accounts: { '0517': 'CAD Jason RSP' },
    },
];

const DATA_DIR = path.join(__dirname, 'temp_data_questrade');
// ====================

async function exchangeToken(refreshToken) {
    const res = await fetch(
        `https://login.questrade.com/oauth2/token?grant_type=refresh_token&refresh_token=${refreshToken}`
    );
    if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
    return res.json();
}

async function getSession(user) {
    const candidates = [];
    if (fs.existsSync(user.tokenFile)) {
        candidates.push({ source: 'stored token file', token: JSON.parse(fs.readFileSync(user.tokenFile, 'utf8')).refreshToken });
    }
    if (process.env[user.envKey]) {
        candidates.push({ source: `env ${user.envKey}`, token: process.env[user.envKey] });
    }
    if (candidates.length === 0) {
        throw new Error(`no refresh token for ${user.name}: set ${user.envKey} in .env`);
    }

    let lastError;
    for (const { source, token } of candidates) {
        try {
            const data = await exchangeToken(token);
            // Questrade rotates the refresh token on every use. Save the new one IMMEDIATELY.
            fs.writeFileSync(user.tokenFile, JSON.stringify({ refreshToken: data.refresh_token }, null, 2), { mode: 0o600 });
            console.log(`${user.name}: authenticated via ${source}`);
            return { accessToken: data.access_token, apiServer: data.api_server };
        } catch (e) {
            console.warn(`${user.name}: ${source} did not work (${e.message})`);
            lastError = e;
        }
    }
    throw new Error(`${user.name}: all tokens failed. Generate a new token in the Questrade API Centre, update ${user.envKey} in .env, and delete ${user.tokenFile}. Last error: ${lastError.message}`);
}

async function qtGet(session, endpoint) {
    const res = await fetch(`${session.apiServer}v1/${endpoint}`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    if (!res.ok) throw new Error(`Questrade API ${endpoint} failed (${res.status})`);
    return res.json();
}

(async () => {
    // 1. Questrade: collect balances across all configured users
    const balancesByName = {};
    let hadErrors = false;

    for (const user of QUESTRADE_USERS) {
        try {
            const session = await getSession(user);
            const { accounts } = await qtGet(session, 'accounts');

            for (const acct of accounts) {
                const last4 = acct.number.toString().slice(-4);
                const abName = user.accounts[last4];
                if (!abName) {
                    console.log(`${user.name}: skipping Questrade ${acct.type} ...${last4} (not mapped)`);
                    continue;
                }
                const { combinedBalances } = await qtGet(session, `accounts/${acct.number}/balances`);
                const cad = combinedBalances.find((b) => b.currency === 'CAD');
                if (!cad) {
                    console.warn(`${user.name}: no CAD combined balance for ...${last4}, skipping`);
                    continue;
                }
                balancesByName[abName] = cad.totalEquity;
                console.log(`${user.name}: Questrade ${acct.type} ...${last4} -> ${abName}: ${cad.totalEquity} CAD`);
            }
        } catch (e) {
            console.error(`${user.name}: FAILED - ${e.message}`);
            hadErrors = true;
        }
    }

    if (Object.keys(balancesByName).length === 0) {
        console.log('Nothing to update.');
        process.exit(hadErrors ? 1 : 0);
    }

    // 2. Actual: write balance_current (integer cents)
    fs.mkdirSync(DATA_DIR, { recursive: true });
    await actual.init({
        serverURL: process.env.ACTUAL_SERVER_URL,
        password: process.env.ACTUAL_SERVER_PASSWORD,
        dataDir: DATA_DIR,
    });
    await actual.downloadBudget(process.env.ACTUAL_BUDGET_ID);

    const abAccounts = await actual.getAccounts();
    for (const [name, totalEquity] of Object.entries(balancesByName)) {
        const abAcct = abAccounts.find((a) => a.name === name);
        if (!abAcct) {
            console.warn(`Actual account "${name}" not found, skipping`);
            hadErrors = true;
            continue;
        }
        const cents = Math.round(totalEquity * 100);
        await actual.updateAccount(abAcct.id, { balance_current: cents });
        console.log(`Updated "${name}" balance_current to ${cents} (cents)`);
    }

    await actual.shutdown();
    console.log('Questrade balance sync complete');
    process.exit(hadErrors ? 1 : 0);
})().catch((e) => {
    console.error('Questrade sync failed:', e.message);
    process.exit(1);
});
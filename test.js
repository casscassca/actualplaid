ACTUAL_SERVER_URL="http://localhost:5006" 
ACTUAL_SERVER_PASSWORD="edp3uze!BTZ1mgx5kev"
ACTUAL_BUDGET_ID="61c5fad9-621b-493d-a0a3-a5f498f7573a"
const actual = require('@actual-app/api');
const fs = require('fs');

(async () => {
    fs.mkdirSync('./temp_test', { recursive: true });
    await actual.init({
        serverURL: process.env.ACTUAL_SERVER_URL,
        password: process.env.ACTUAL_SERVER_PASSWORD,
        dataDir: './temp_test'
    });
    await actual.downloadBudget(process.env.ACTUAL_BUDGET_ID);
    const accounts = await actual.getAccounts();
    console.log('Account notes:');
    for (const a of accounts) {
        const note = await actual.getNote(a.id);
        console.log(a.name, '|', note ?? '(no note)');
    }
    await actual.shutdown();
})();

require('dotenv').config();
const { getImpersonatedClient } = require('./src/auth');
const { getUserActivity } = require('./src/workspace');

async function debug() {
    try {
        const userEmail = 'samyuktha.n@innovcentric.com';
        console.log(`[Test] Calling getUserActivity for: ${userEmail}`);

        const authClient = await getImpersonatedClient(userEmail);

        // Use the exact date range from User's screenshot
        const startDate = "2024-12-01";
        const endDate = "2024-12-28";

        console.log(`[Test] Date Range: ${startDate} to ${endDate}`);

        const detailedEmails = await getUserActivity(authClient, userEmail, startDate, endDate, null);

        console.log("--- RESULT ---");
        console.log(`Is Array: ${Array.isArray(detailedEmails)}`);
        console.log(`Array Length: ${detailedEmails.length}`);

        if (detailedEmails.meta) {
            console.log("Meta exists!");
            console.log(`Meta Total: ${detailedEmails.meta.total}`);
            console.log(`Meta Fetched: ${detailedEmails.meta.fetched}`);
        } else {
            console.error("Meta IS MISSING!");
        }

    } catch (e) {
        console.error("Debug Failed:", e);
    }
}

debug();

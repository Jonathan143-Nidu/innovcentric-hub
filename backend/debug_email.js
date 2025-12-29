
require('dotenv').config();
const { google } = require('googleapis');
const { getImpersonatedClient } = require('./src/auth');

async function debug() {
    try {
        console.log("Debugging for user: samyuktha.n@innovcentric.com");
        const authClient = await getImpersonatedClient('samyuktha.n@innovcentric.com');
        const gmail = google.gmail({ version: 'v1', auth: authClient });

        // Search for the specific Indeed email
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'subject:"eBusiness Solutions" label:INBOX',
            maxResults: 5
        });

        const messages = res.data.messages || [];
        console.log(`Found ${messages.length} messages.`);

        for (const msg of messages) {
            const full = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id
            });

            const headers = full.data.payload.headers;
            const subject = headers.find(h => h.name === 'Subject')?.value;
            const dateHeader = headers.find(h => h.name === 'Date')?.value;
            const internalDate = full.data.internalDate;

            console.log('--- Email ---');
            console.log(`ID: ${msg.id}`);
            console.log(`Subject: ${subject}`);
            console.log(`Date Header: ${dateHeader}`);
            console.log(`Internal Date (Epoch): ${internalDate}`);

            // Convert to IST (User's Time)
            const dateObj = new Date(parseInt(internalDate));
            const istStr = dateObj.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
            console.log(`Internal Date (IST): ${istStr}`);

            // Check Snippet
            console.log(`Snippet: ${full.data.snippet.substring(0, 50)}...`);
        }
    } catch (e) {
        console.error(e);
    }
}

debug();

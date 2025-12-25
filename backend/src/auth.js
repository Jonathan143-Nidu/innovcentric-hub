const { GoogleAuth, Impersonated } = require('google-auth-library');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// The Service Account Email
const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL;

const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/admin.directory.user.readonly',
    'https://www.googleapis.com/auth/admin.directory.userschema.readonly',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
];

/**
 * Hybrid Authentication Strategy:
 * 1. Checks for 'service-account.json' locally (Fastest for local testing without gcloud).
 * 2. Falls back to IAM Credentials API (Best for Cloud Run).
 */
async function getImpersonatedClient(userEmail) {
    // --- STRATEGY 1: Local Key File ---
    // Look for the file in the backend folder
    const keyFilePath = path.join(__dirname, '../service-account.json');

    if (fs.existsSync(keyFilePath)) {
        console.log(`[Auth] 🟢 Found local key file. Using for impersonation of ${userEmail}`);

        // For DWD with a key file, we simply pass the subject to GoogleAuth
        const auth = new GoogleAuth({
            keyFile: keyFilePath,
            scopes: SCOPES,
            clientOptions: {
                subject: userEmail // Impersonation target
            }
        });
        return auth.getClient();
    }

    // --- STRATEGY 2: Keyless (IAM Credentials API) ---
    // Uses the Cloud Run Service Account Identity to impersonate the Workspace User
    console.log(`[Auth] ☁️ No local key found. Using IAM Impersonation for ${userEmail}`);

    try {
        // 1. Get the base credentials of the Cloud Run instance
        const auth = new GoogleAuth({
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });
        const sourceClient = await auth.getClient();

        // 2. Create the Impersonated Client
        // Note: The Service Account needs "Service Account Token Creator" role on itself.
        const targetClient = new Impersonated({
            sourceClient: sourceClient,
            targetPrincipal: userEmail, // The user we want to act as
            lifetime: 3600,             // 1 Hour
            targetScopes: SCOPES,
            delegates: [],              // No intermediate service accounts
        });

        // The Impersonated client implements the auth interface directly
        // But we need to verify if it works by refreshing it (acquiring headers)
        // console.log(`[Auth] Impersonated Client created. Principal: ${userEmail}`);

        return targetClient;

    } catch (e) {
    });

    try {
        const iam = google.iamcredentials({ version: 'v1', auth: client });
        const signResponse = await iam.projects.serviceAccounts.signJwt({
            name: `projects/-/serviceAccounts/${SERVICE_ACCOUNT_EMAIL}`,
            requestBody: { payload: payload }
        });

        const tokenResponse = await client.request({
            url: 'https://oauth2.googleapis.com/token',
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${signResponse.data.signedJwt}`
        });

        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({ access_token: tokenResponse.data.access_token });
        return oauth2Client;

    } catch (err) {
        console.error(`[Auth] ❌ Authentication Failed.`);
        console.error(`Reason: Missing 'service-account.json' AND missing local 'gcloud' login.`);
        console.error(`Tip: For local testing, put the JSON key file in the 'backend' folder.`);
        throw err;
    }
}

module.exports = { getImpersonatedClient };

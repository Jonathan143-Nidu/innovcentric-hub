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
        return targetClient;

    } catch (e) {
        console.error(`[Auth] FATAL: Failed to configure impersonation for ${userEmail}:`, e.message);
        throw new Error(`Impersonation Config Failed: ${e.message}`);
    }
}

module.exports = { getImpersonatedClient };

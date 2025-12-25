const { GoogleAuth } = require('google-auth-library');
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
    console.log(`[Auth] ☁️ No local key found. Attempting Cloud IAM SignJwt for ${userEmail}`);

    try {
        // Get base credentials (requires 'service_account_token_creator' role)
        const auth = new GoogleAuth({
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });
        const client = await auth.getClient();

        // Create JWT for DWD
        const iat = Math.floor(Date.now() / 1000);
        const exp = iat + 3600; // 1 hour

        const payload = {
            iss: client.email, // Service Account Email
            sub: userEmail,    // User to impersonate
            aud: 'https://oauth2.googleapis.com/token',
            iat,
            exp,
            scope: SCOPES.join(' ')
        };

        // Sign the JWT using IAM API
        const iam = google.iamcredentials({ version: 'v1', auth: client });
        const name = `projects/-/serviceAccounts/${client.email}`;

        console.log(`[Auth] Signing JWT as ${client.email}...`);

        const res = await iam.projects.serviceAccounts.signJwt({
            name: name,
            requestBody: {
                payload: JSON.stringify(payload)
            }
        });

        const jwt = res.data.signedJwt;
        // Exchange JWT for Access Token
        const tokenRes = await google.oauth2('v2').tokeninfo({
            access_token: null, // Hack to get client
            id_token: null
        });
        // Wait, we need to POST to oauth2 endpoint manually or use a helper. 
        // Easier: Use the signed JWT to create a simple OAuth2Client with credentials?
        // Actually, the standard pattern for DWD with IAM is to exchange the signed JWT for an access token.

        // Let's use a simpler approach if possible? No, we need an access token for the USER.

        // Manual Exchange
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
        // Error: node-fetch might not be installed. Use native fetch/axios/or built-in https.
        // Node 18+ has fetch. Cloud Run is likely 20+.

        const tokenResponse = await global.fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: jwt
            })
        });

        const tokenData = await tokenResponse.json();
        if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

        const accessToken = tokenData.access_token;

        // Return a mock Auth Client that just adds the header
        const oAuth2Client = new google.auth.OAuth2();
        oAuth2Client.setCredentials({ access_token: accessToken });
        return oAuth2Client;

    } catch (e) {
        console.error(`[Auth] FATAL: Failed to impersonate ${userEmail}:`, e.message);
        throw new Error(`Impersonation Failed: ${e.message}`);
    }
    const payload = JSON.stringify({
        iss: SERVICE_ACCOUNT_EMAIL,
        sub: userEmail,
        scope: SCOPES.join(' '),
        aud: 'https://oauth2.googleapis.com/token',
        iat: iat,
        exp: iat + 3600
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

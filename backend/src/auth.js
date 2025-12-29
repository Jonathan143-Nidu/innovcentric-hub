const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const https = require('https'); // Use native https to avoid dependency issues

// The Service Account Email
const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL;
// The Cloud Run Service Account (The one we are running as)
// We can auto-detect this, but better to rely on ADC.

const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/admin.directory.user.readonly',
    'https://www.googleapis.com/auth/admin.directory.userschema.readonly',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
];

/**
 * Helper to make HTTP POST request without external dependencies like axios/node-fetch
 */
function postRequest(url, data, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname,
            method: 'POST',
            headers: {
                ...headers,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(json);
                    } else {
                        reject(new Error(json.error_description || json.error || `HTTP ${res.statusCode}`));
                    }
                } catch (e) {
                    reject(new Error(`Invalid JSON response: ${body}`));
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(data);
        req.end();
    });
}

/**
 * KEYLESS DOMAIN-WIDE DELEGATION
 */
async function getImpersonatedClient(userEmail) {
    // --- STRATEGY 1: Local Key File (Dev) ---
    const keyFilePath = path.join(__dirname, '../service-account.json');
    if (fs.existsSync(keyFilePath)) {
        console.log(`[Auth] 🟢 Found local key file. Using for ${userEmail}`);
        const auth = new GoogleAuth({
            keyFile: keyFilePath,
            scopes: SCOPES,
            clientOptions: { subject: userEmail }
        });
        return auth.getClient();
    }

    // --- STRATEGY 2: Keyless Cloud Run (Prod) ---
    // The previous 'Impersonated' class failed because it acts as a Service Account, not a User.
    // We must manually sign a JWT with 'sub' claim for DWD.
    console.log(`[Auth] ☁️ Keyless Mode. Performing manual DWD for ${userEmail}`);

    try {
        // 1. Get ADC to talk to IAM Credentials API
        const auth = new GoogleAuth({
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });
        const adcClient = await auth.getClient();

        // 2. We need our own email (The Service Account's email)
        // If SERVICE_ACCOUNT_EMAIL env var is set, use it.
        // Otherwise, try to guess or use the error fallback.
        let saEmail = SERVICE_ACCOUNT_EMAIL;
        if (!saEmail) {
            // Fallback: This might fail if env var is missing, but usually Cloud Run injects identity.
            // We'll rely on the user having set it or provided it.
            // If missing, we can try to fetch it from metadata server, but let's assume Env Var for now
            // as it was in the user's .env file.
            throw new Error("SERVICE_ACCOUNT_EMAIL environment variable is required for Keyless DWD.");
        }

        console.log(`[Auth] Signing JWT as ${saEmail} for subject ${userEmail}...`);

        // 3. Construct the JWT Payload for DWD
        const iat = Math.floor(Date.now() / 1000);
        const exp = iat + 3600; // 1 hour

        const payload = JSON.stringify({
            iss: saEmail,
            sub: userEmail, // THIS IS THE KEY: We claim to be the user
            aud: 'https://oauth2.googleapis.com/token',
            iat: iat,
            exp: exp,
            scope: SCOPES.join(' ')
        });

        // 4. Sign the JWT using IAM Credentials API
        const iam = google.iamcredentials({ version: 'v1', auth: adcClient });
        const name = `projects/-/serviceAccounts/${saEmail}`;

        const signResponse = await iam.projects.serviceAccounts.signJwt({
            name: name,
            requestBody: { payload: payload }
        });

        const signedJwt = signResponse.data.signedJwt;
        console.log(`[Auth] JWT Signed successfully.`);

        // 5. Exchange Signed JWT for Access Token via OAuth2
        const tokenResponse = await postRequest(
            'https://oauth2.googleapis.com/token',
            `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${signedJwt}`
        );

        console.log(`[Auth] Token acquired for ${userEmail}`);

        // 6. Return an OAuth2Client with the token
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({
            access_token: tokenResponse.access_token,
            expiry_date: Date.now() + (tokenResponse.expires_in * 1000)
        });

        return oauth2Client;

    } catch (e) {
        console.error(`[Auth] ❌ Keyless DWD Failed for ${userEmail}:`, e.message);
        // Add helpful hint for the specific error we saw before
        if (e.message.includes('Gaia id not found') || e.message.includes('NOT_FOUND')) {
            console.error("HINT: This error usually means the Service Account Email used for signing is wrong, OR the IAM API cannot find the Service Account.");
            console.error(`Attempted to sign as: ${SERVICE_ACCOUNT_EMAIL}`);
        }
        throw new Error(`Auth Failed: ${e.message}`);
    }
}

module.exports = { getImpersonatedClient };

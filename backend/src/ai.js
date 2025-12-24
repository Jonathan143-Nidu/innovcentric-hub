const OpenAI = require('openai');

// NOTE: In production, use process.env.OPENAI_API_KEY
// For this session, we use the provided key.
const API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({
    apiKey: API_KEY,
});

/**
 * Clean email body to remove clutter before sending to AI (save tokens/cost)
 */
function cleanText(text) {
    if (!text) return "";
    // Remove quoted replies (simple heuristic: lines starting with >)
    // and excessively long strings.
    return text.split('\n')
        .filter(line => !line.trim().startsWith('>'))
        .join('\n')
        .substring(0, 3000); // Limit context window
}

/**
 * Extracts RTR details: Client, Rate, Candidate Name, Position
 */
async function extractRTRDetails(emailBody, subject) {
    try {
        const content = cleanText(emailBody);
        const prompt = `
        Analyze this email content and subject related to a job application or "Right to Represent" (RTR).
        Extract the following fields in JSON format:
        - "client": The name of the end client company (e.g. Nike, Apple). If unknown, use "Unknown".
        - "rate": The pay rate mentioned (e.g. $50/hr, 80k/yr). If unknown, use "N/A".
        - "candidate": The full name of the job candidate being represented. if unknown, use "Unknown".
        - "position": The job title / role.
        - "location": The job location (City, State, or Remote).
        - "vendor": Any vendor or staffing agency mentioned (other than Innovcentric).
        - "date_context": Extract the date of the RTR if explicitly mentioned in the text (e.g. "Represent for 12/23").

        Subject: ${subject}
        Body: ${content}

        Return ONLY raw JSON. No markdown.
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0,
            max_tokens: 250
        });

        const raw = response.choices[0].message.content.trim();
        // Strip markdown code blocks if present
        const jsonStr = raw.replace(/^```json/, '').replace(/```$/, '');
        return JSON.parse(jsonStr);

    } catch (error) {
        console.error("OpenAI RTR Extraction Error:", error.message);
        return { client: "Unknown", rate: "N/A", candidate: "Unknown", position: subject, location: "Unknown", vendor: "Unknown" };
    }
}

module.exports = { extractRTRDetails };

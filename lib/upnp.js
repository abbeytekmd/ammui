import axios from 'axios';
import xml2js from 'xml2js';

export function xmlEscape(str) {
    if (str === 0) return '0';
    return (str || '').toString().replace(/[<>&"']/g, c => ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": "&apos;"
    }[c]));
}

export async function soapCall(url, serviceType, action, args = {}) {
    const argXml = Object.entries(args).map(([key, val]) => `<${key}>${xmlEscape(val)}</${key}>`).join('');
    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">
      ${argXml}
    </u:${action}>
  </s:Body>
</s:Envelope>`;

    try {
        const response = await axios.post(url, body, {
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                'SOAPACTION': `"${serviceType}#${action}"`
            },
            timeout: 5000
        });

        let result;
        if (typeof response.data === 'object' && response.data !== null) {
            result = response.data;
        } else if (typeof response.data === 'string' && response.data.trim().startsWith('<')) {
            // Clean the XML to handle servers that may include BOM or other issues
            let cleanedXml = response.data;
            // Remove BOM (Byte Order Mark) if present
            cleanedXml = cleanedXml.replace(/^\uFEFF/, '');
            // Trim any leading/trailing whitespace
            cleanedXml = cleanedXml.trim();
            // Remove any non-XML characters before the first '<'
            const firstTag = cleanedXml.indexOf('<');
            if (firstTag > 0) {
                cleanedXml = cleanedXml.substring(firstTag);
            }

            const parser = new xml2js.Parser({
                explicitArray: false,
                tagNameProcessors: [xml2js.processors.stripPrefix]
            });
            try {
                result = await parser.parseStringPromise(cleanedXml);
            } catch (parseError) {
                console.error(`[SOAP] XML Parse Error for ${action}:`, parseError.message);
                console.error(`[SOAP] First 200 chars:`, cleanedXml.substring(0, 200));
                throw new Error(`Failed to parse SOAP response: ${parseError.message}`);
            }
        } else if (typeof response.data === 'string' && (response.data.trim().startsWith('{') || response.data.trim().startsWith('['))) {
            try {
                result = JSON.parse(response.data);
            } catch (e) {
                console.error(`Failed to parse response as JSON from ${url}: ${e.message}`);
                throw new Error(`Unexpected response format from ${url}: starts with ${response.data.trim()[0]}`);
            }
        } else {
            throw new Error(`Unexpected response format from ${url}: ${typeof response.data === 'string' ? response.data.substring(0, 20) : typeof response.data}`);
        }

        const envelope = result.Envelope || result['s:Envelope'] || result;
        const respBody = envelope.Body || envelope['s:Body'] || envelope;
        return respBody[`${action}Response`];
    } catch (err) {
        let errorMessage = err.message;
        if (err.response && err.response.data) {
            try {
                const parser = new xml2js.Parser({ explicitArray: false, tagNameProcessors: [xml2js.processors.stripPrefix] });
                const errResult = await parser.parseStringPromise(err.response.data);
                const fault = errResult.Envelope && errResult.Envelope.Body ? errResult.Envelope.Body.Fault : null;
                if (fault && fault.detail && fault.detail.UPnPError) {
                    const upnpErr = fault.detail.UPnPError;
                    const code = upnpErr.errorCode || 'Unknown';
                    const description = upnpErr.errorDescription || 'No description';
                    errorMessage = `UPnP Error ${code}: ${description}`;
                    console.error(`[DEBUG] Parsed ${action} UPnP Error:`, errorMessage);
                }
            } catch (pErr) {
                // Keep original message if parsing fails
            }
        }

        const enhancedErr = new Error(errorMessage);
        enhancedErr.originalError = err;
        enhancedErr.status = err.response ? err.response.status : null;
        throw enhancedErr;
    }
}

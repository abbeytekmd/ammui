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

        const parser = new xml2js.Parser({
            explicitArray: false,
            tagNameProcessors: [xml2js.processors.stripPrefix]
        });
        const result = await parser.parseStringPromise(response.data);

        const envelope = result.Envelope || result['s:Envelope'] || result;
        const respBody = envelope.Body || envelope['s:Body'] || envelope;
        return respBody[`${action}Response`];
    } catch (err) {
        console.error(`SOAP Action ${action} Failed:`, err.message);
        if (err.response && err.response.data) {
            try {
                const parser = new xml2js.Parser({ explicitArray: false, tagNameProcessors: [xml2js.processors.stripPrefix] });
                const errResult = await parser.parseStringPromise(err.response.data);
                const fault = errResult.Envelope.Body.Fault;
                if (fault && fault.detail && fault.detail.UPnPError) {
                    console.error('Parsed UPnP Error:', JSON.stringify(fault.detail.UPnPError, null, 2));
                }
            } catch (pErr) {
                // Ignore parsing inner error
            }
        }
        throw err;
    }
}

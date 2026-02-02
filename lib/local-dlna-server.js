import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Server } from 'node-ssdp';
import { fileURLToPath } from 'url';
import { xmlEscape } from './upnp.js';
import xml2js from 'xml2js';
import { parseFile } from 'music-metadata';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..', 'local');

export function getLocalIp() {
  const interfaces = os.networkInterfaces();
  const preferred = [];

  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal && alias.mac.localeCompare('00:00:00:00:00:00') !== 0) {
        preferred.push(alias.address);
        console.log('Found address:', alias);
      }
    }
  }

  const result = preferred[0] || '127.0.0.1';
  console.log(`[DEBUG] getLocalIp detected: ${result} (Preferred: ${preferred})`);
  return result;
}

export const SERVER_UDN = 'uuid:ammui-local-media-server';
let currentDeviceName = 'AMMUI Media Library';

export function updateLocalDlnaName(deviceName) {
  if (deviceName) currentDeviceName = `${deviceName} Media Library`;
}

export function setupLocalDlna(app, port, deviceName) {
  if (deviceName) currentDeviceName = `${deviceName} Media Library`;
  const hostIp = getLocalIp();

  // 1. Description XML
  app.get('/dlna/description.xml', (_req, res) => {
    const xml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${currentDeviceName}</friendlyName>
    <manufacturer>AMMUI</manufacturer>
    <manufacturerURL>https://github.com/abbeytekmd/ammui</manufacturerURL>
    <modelDescription>AMMUI Local DLNA Server</modelDescription>
    <modelName>AMMUI-MS-1</modelName>
    <modelURL>https://github.com/abbeytekmd/ammui</modelURL>
    <UDN>${SERVER_UDN}</UDN>
    <iconList>
      <icon>
        <mimetype>image/png</mimetype>
        <width>600</width>
        <height>600</height>
        <depth>24</depth>
        <url>/amm-icon.png</url>
      </icon>
    </iconList>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <SCPDURL>/dlna/ContentDirectory.xml</SCPDURL>
        <controlURL>/dlna/ContentDirectory/control</controlURL>
        <eventSubURL>/dlna/ContentDirectory/event</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/dlna/ConnectionManager.xml</SCPDURL>
        <controlURL>/dlna/ConnectionManager/control</controlURL>
        <eventSubURL>/dlna/ConnectionManager/event</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;
    res.set('Content-Type', 'text/xml').send(xml);
  });

  // 2. Service Definitions (SCPD)
  app.get('/dlna/ContentDirectory.xml', (_req, res) => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action>
      <name>Browse</name>
      <argumentList>
        <argument><name>ObjectID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
        <argument><name>BrowseFlag</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument>
        <argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
        <argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
        <argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
        <argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
        <argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action><name>GetSystemUpdateID</name><argumentList><argument><name>Id</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument></argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType><allowedValueList><allowedValue>BrowseMetadata</allowedValue><allowedValue>BrowseDirectChildren</allowedValue></allowedValueList></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Filter</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SortCriteria</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;
    res.set('Content-Type', 'text/xml').send(xml);
  });

  app.get('/dlna/ConnectionManager.xml', (_req, res) => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>GetProtocolInfo</name><argumentList><argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument><argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument></argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;
    res.set('Content-Type', 'text/xml').send(xml);
  });

  // 3. Control Handlers (SOAP)
  app.post('/dlna/ContentDirectory/control', express.text({ type: 'text/xml' }), async (req, res) => {
    const soapAction = req.headers.soapaction || '';
    const actionMatch = soapAction.match(/#([^"]+)/);
    const action = actionMatch ? actionMatch[1] : '';

    const parser = new xml2js.Parser({ explicitArray: false, tagNameProcessors: [xml2js.processors.stripPrefix] });
    const soapRequest = await parser.parseStringPromise(req.body);
    const args = soapRequest.Envelope.Body[action];

    if (action === 'Browse') {
      // Determine baseUrl dynamically based on the request host to ensure the right IP is sent to the client
      const requestHost = req.headers.host || `${hostIp}:${port}`;
      const dynamicBaseUrl = `http://${requestHost}`;
      console.log(`[DEBUG] SOAP Browse incoming from ${req.ip}, using baseUrl=${dynamicBaseUrl}`);

      const result = await handleBrowse(args, dynamicBaseUrl);
      const resp = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <Result>${xmlEscape(result.didl)}</Result>
      <NumberReturned>${result.count}</NumberReturned>
      <TotalMatches>${result.total}</TotalMatches>
      <UpdateID>0</UpdateID>
    </u:BrowseResponse>
  </s:Body>
</s:Envelope>`;
      res.set('Content-Type', 'text/xml; charset="utf-8"').send(resp);
    } else if (action === 'GetSystemUpdateID') {
      const resp = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetSystemUpdateIDResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><Id>0</Id></u:GetSystemUpdateIDResponse>
  </s:Body>
</s:Envelope>`;
      res.set('Content-Type', 'text/xml; charset="utf-8"').send(resp);
    } else {
      res.status(404).send('Action not found');
    }
  });

  app.post('/dlna/ConnectionManager/control', (_req, res) => {
    const resp = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetProtocolInfoResponse xmlns:u="urn:schemas-upnp-org:service:ConnectionManager:1">
      <Source>http-get:*:audio/mpeg:*,http-get:*:audio/wav:*,http-get:*:audio/flac:*,http-get:*:audio/x-flac:*</Source>
      <Sink></Sink>
    </u:GetProtocolInfoResponse>
  </s:Body>
</s:Envelope>`;
    res.set('Content-Type', 'text/xml; charset="utf-8"').send(resp);
  });

  // 4. File Serving
  app.use('/local-files', express.static(ROOT_DIR));

  // 5. SSDP Advertisement
  const ssdpServer = new Server({
    location: `http://${hostIp}:${port}/dlna/description.xml`,
    udn: SERVER_UDN,
    allowWildcards: true
  });

  ssdpServer.addUSN('upnp:rootdevice');
  ssdpServer.addUSN('urn:schemas-upnp-org:device:MediaServer:1');
  ssdpServer.addUSN('urn:schemas-upnp-org:service:ContentDirectory:1');
  ssdpServer.addUSN('urn:schemas-upnp-org:service:ConnectionManager:1');

  ssdpServer.start();
  console.log(`Local DLNA Media Server started at ${hostIp}:${port}`);

  // Graceful stop
  process.on('SIGINT', () => {
    console.log('Stopping local SSDP server...');
    ssdpServer.stop();
  });
}

async function handleBrowse(args, baseUrl) {
  const objectId = (args.ObjectID || '0').replace(/\\/g, '/');
  const browseFlag = args.BrowseFlag;

  let result = { didl: '', count: 0, total: 0 };
  let items = [];

  if (browseFlag === 'BrowseMetadata') {
    const title = objectId === '0' ? currentDeviceName : path.basename(objectId);
    items.push({
      id: objectId,
      parentID: objectId === '0' ? '-1' : path.dirname(objectId).replace(/\\/g, '/'),
      title: title,
      class: 'object.container.storageFolder',
      isContainer: true
    });
  } else {
    // BrowseDirectChildren
    const relativePath = objectId === '0' ? '.' : objectId;
    const fullPath = path.resolve(ROOT_DIR, relativePath);

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      const files = fs.readdirSync(fullPath, { withFileTypes: true });

      for (const file of files) {
        // Ensure the ID always uses forward slashes for DLNA compatibility
        const itemPath = (objectId === '0' ? '' : objectId + '/') + file.name;

        if (file.isDirectory()) {
          items.push({
            id: itemPath,
            parentID: objectId,
            title: file.name,
            class: 'object.container.storageFolder',
            isContainer: true
          });
        } else if (file.isFile()) {
          const ext = path.extname(file.name).toLowerCase();
          if (['.mp3', '.wav', '.flac', '.m4a', '.aac'].includes(ext)) {
            const mime = ext === '.mp3' ? 'audio/mpeg' : (ext === '.wav' ? 'audio/wav' : 'audio/flac');
            const filePath = path.join(fullPath, file.name);

            // Read metadata from the file
            let metadata = {
              title: file.name.replace(ext, ''),
              artist: '',
              album: '',
              genre: '',
              year: '',
              trackNumber: 0,
              duration: ''
            };

            try {
              const tags = await parseFile(filePath, { duration: true });
              if (tags.common) {
                metadata.title = tags.common.title || metadata.title;
                metadata.artist = tags.common.artist || '';
                metadata.album = tags.common.album || '';
                metadata.genre = tags.common.genre ? tags.common.genre.join(', ') : '';
                metadata.year = tags.common.year ? String(tags.common.year) : '';
                metadata.trackNumber = tags.common.track?.no || 0;

                // Format duration as HH:MM:SS
                if (tags.format && tags.format.duration) {
                  const totalSeconds = Math.floor(tags.format.duration);
                  const hours = Math.floor(totalSeconds / 3600);
                  const minutes = Math.floor((totalSeconds % 3600) / 60);
                  const seconds = totalSeconds % 60;
                  metadata.duration = `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
                }
              }
            } catch (err) {
              console.warn(`[DLNA] Failed to read metadata for ${file.name}:`, err.message);
            }

            items.push({
              id: itemPath,
              parentID: objectId,
              title: metadata.title,
              artist: metadata.artist,
              album: metadata.album,
              genre: metadata.genre,
              year: metadata.year,
              trackNumber: metadata.trackNumber,
              duration: metadata.duration,
              class: 'object.item.audioItem.musicTrack',
              isContainer: false,
              uri: `${baseUrl}/local-files/${itemPath.split('/').map(encodeURIComponent).join('/')}`,
              mime: mime
            });
          }
        }
      }
    }
  }

  result.count = items.length;
  result.total = items.length;
  result.didl = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
${items.map(item => {
    if (item.isContainer) {
      return `  <container id="${xmlEscape(item.id)}" parentID="${xmlEscape(item.parentID)}" restricted="0">
    <dc:title>${xmlEscape(item.title)}</dc:title>
    <upnp:class>${item.class}</upnp:class>
  </container>`;
    } else {
      // Build metadata fields
      let metadata = `    <dc:title>${xmlEscape(item.title)}</dc:title>
    <upnp:class>${item.class}</upnp:class>`;

      if (item.artist) {
        metadata += `\n    <upnp:artist>${xmlEscape(item.artist)}</upnp:artist>`;
        metadata += `\n    <dc:creator>${xmlEscape(item.artist)}</dc:creator>`;
      }
      if (item.album) {
        metadata += `\n    <upnp:album>${xmlEscape(item.album)}</upnp:album>`;
      }
      if (item.genre) {
        metadata += `\n    <upnp:genre>${xmlEscape(item.genre)}</upnp:genre>`;
      }
      if (item.year) {
        metadata += `\n    <dc:date>${xmlEscape(item.year)}</dc:date>`;
      }
      if (item.trackNumber) {
        metadata += `\n    <upnp:originalTrackNumber>${item.trackNumber}</upnp:originalTrackNumber>`;
      }

      // Resource with duration if available
      let resAttrs = `protocolInfo="http-get:*:${item.mime}:*"`;
      if (item.duration) {
        resAttrs += ` duration="${xmlEscape(item.duration)}"`;
      }

      return `  <item id="${xmlEscape(item.id)}" parentID="${xmlEscape(item.parentID)}" restricted="0">
${metadata}
    <res ${resAttrs}>${xmlEscape(item.uri)}</res>
  </item>`;
    }
  }).join('\n')}
</DIDL-Lite>`;

  return result;
}

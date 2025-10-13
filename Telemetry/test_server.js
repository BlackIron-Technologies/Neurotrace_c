// Test script para probar el servidor de telemetría
const https = require('http');

const testData = {
    sessionId: "test-session-123",
    extensionVersion: "1.0.0",
    vscodeVersion: "1.80.0",
    platform: "Windows",
    weekStart: "2025-10-01",
    events: [
        {
            eventType: "thought_created",
            timestamp: new Date().toISOString(),
            anonymousId: "test-user-123",
            metadata: {
                thoughtType: "note",
                hasCodeSnippet: false
            }
        },
        {
            eventType: "graph_opened",
            timestamp: new Date().toISOString(),
            anonymousId: "test-user-123"
        }
    ],
    aggregatedStats: {
        totalThoughts: 5,
        totalGraphOpens: 2
    }
};

const postData = JSON.stringify(testData);

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/telemetry',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
    }
};

console.log('🧪 Enviando datos de prueba al servidor...');

const req = https.request(options, (res) => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Headers:`, res.headers);

    let body = '';
    res.on('data', (chunk) => {
        body += chunk;
    });

    res.on('end', () => {
        console.log('📄 Respuesta del servidor:');
        console.log(JSON.parse(body));

        if (res.statusCode === 200) {
            console.log('✅ Prueba exitosa: El servidor procesó los datos correctamente');
        } else {
            console.log('❌ Prueba fallida: Error en el servidor');
        }
    });
});

req.on('error', (e) => {
    console.error('❌ Error en la petición:', e.message);
});

req.write(postData);
req.end();
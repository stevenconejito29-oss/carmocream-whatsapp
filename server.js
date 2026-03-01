const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// --- CONFIGURACIÓN ---
const WA_SECRET = process.env.WA_SECRET || 'carmocream2024';
let lastQr = null;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        handleSIGINT: false,
        executablePath: process.env.CHROME_PATH || null, // Útil si usas Nixpacks o Docker
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--no-first-run',
            '--no-zygote',
        ],
    }
});

// --- EVENTOS ---
client.on('qr', (qr) => {
    lastQr = qr;
    console.log(' [!] Nuevo QR generado. Mantenlo privado.');
});

client.on('ready', () => {
    console.log(' ✅ WhatsApp Client conectado y listo');
    lastQr = null;
});

client.on('auth_failure', (msg) => console.error(' ❌ Error de autenticación:', msg));

// --- ENDPOINTS ---

// 1. Enviar Mensaje (Usado por el Admin Panel)
app.post('/send-message', async (req, res) => {
    const { phone, message, secret } = req.body;

    if (secret !== WA_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const formattedPhone = phone.includes('@c.us') ? phone : `${phone}@c.us`;
        await client.sendMessage(formattedPhone, message);
        res.json({ success: true, target: formattedPhone });
    } catch (err) {
        console.error('Error enviando mensaje:', err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Ver estado y QR (Por si necesitas vincular)
app.get('/status', (req, res) => {
    if (lastQr) {
        // Devuelve una página simple con el QR para escanear desde el móvil
        res.send(`
            <div style="text-align:center;font-family:sans-serif;padding:20px;">
                <h2>Escanea el QR para CarmoCream</h2>
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(lastQr)}" />
                <p>El QR se actualiza solo. Refresca si expira.</p>
            </div>
        `);
    } else {
        res.send('✅ Cliente conectado o esperando inicialización...');
    }
});

app.get('/', (req, res) => res.send('CarmoCream WA Server Active 🍦'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
    client.initialize();
});

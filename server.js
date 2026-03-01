// Variable global para guardar el QR actual
let lastQr = null;

client.on('qr', (qr) => {
    lastQr = qr; // Esto es vital para que el endpoint /status lo encuentre
    console.log(' [!] Nuevo QR generado. Mantenlo privado.');
});
// Endpoint para visualizar el QR desde el navegador
app.get('/status', (req, res) => {
    if (lastQr) {
        res.send(`
            <div style="text-align:center;font-family:sans-serif;padding:40px;">
                <h1 style="color:#2D6A4F;">🍦 Vincular CarmoCream</h1>
                <p>Escanea este código con tu WhatsApp:</p>
                <div style="background:white; padding:20px; display:inline-block; border: 2px solid #2D6A4F; border-radius:15px;">
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(lastQr)}" />
                </div>
                <p style="color:#666;margin-top:20px;">El código se actualiza automáticamente. Refresca si no carga.</p>
            </div>
        `);
    } else {
        res.send(`
            <div style="text-align:center;font-family:sans-serif;padding:40px;">
                <h1 style="color:#2D6A4F;">✅ WhatsApp Conectado</h1>
                <p>El cliente ya está listo para enviar mensajes.</p>
                <a href="/">Volver al inicio</a>
            </div>
        `);
    }
});

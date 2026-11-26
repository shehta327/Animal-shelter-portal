// Runs the same Express app on your PC: npm run dev
const app = require('./app');

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`${process.env.SERVICE_NAME || 'service'} listening on http://localhost:${PORT}`));

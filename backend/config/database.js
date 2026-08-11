const sql = require('mssql');
require('dotenv').config();

const config = {
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD || '7esT_$1n3Fi',
  server: process.env.DB_SERVER || '172.28.5.231',
  database: process.env.DB_NAME || 'SIF',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
    connectionTimeout: 30000,
    requestTimeout: 30000,
  },
  pool: {
    max: 20,
    min: 2,
    idleTimeoutMillis: 30000,
  },
};

let pool = null;

async function getPool() {
  if (!pool) {
    pool = await sql.connect(config);
    console.log('✅ Conectado a SQL Server SIF — 172.28.5.231');
  }
  return pool;
}

async function query(queryString, inputs = []) {
  const p = await getPool();
  const request = p.request();
  inputs.forEach(({ name, type, value }) => {
    request.input(name, type, value);
  });
  return request.query(queryString);
}

module.exports = { getPool, query, sql };

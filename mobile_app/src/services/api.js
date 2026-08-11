import { AsyncStorage } from 'react-native';

const API_BASE_URL = 'http://172.28.5.231:3000/api/mobile';

export const mobileAPI = {
  login: async (numSocio, pin) => {
    const res = await fetch(`${API_BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numSocio, pin }),
    });
    return res.json();
  },

  getResumen: async (token) => {
    const res = await fetch(`${API_BASE_URL}/resumen`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.json();
  },

  getCuentas: async (token) => {
    const res = await fetch(`${API_BASE_URL}/cuentas`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.json();
  },

  getCreditos: async (token) => {
    const res = await fetch(`${API_BASE_URL}/creditos`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.json();
  },

  realizarTransferencia: async (token, cuentaOrigenId, cuentaDestino, monto, concepto) => {
    const res = await fetch(`${API_BASE_URL}/transferencia`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cuentaOrigenId, cuentaDestino, monto, concepto }),
    });
    return res.json();
  }
};

import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ScrollView, SafeAreaView, ActivityIndicator } from 'react-native';
import { mobileAPI } from './src/services/api';

export default function App() {
  const [numSocio, setNumSocio] = useState('35-178849');
  const [pin, setPin] = useState('1234');
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(false);

  const [resumen, setResumen] = useState(null);
  const [cuentas, setCuentas] = useState([]);
  const [creditos, setCreditos] = useState([]);

  const handleLogin = async () => {
    setLoading(true);
    try {
      const data = await mobileAPI.login(numSocio, pin);
      if (data.success) {
        setToken(data.token);
        cargarDatos(data.token);
      } else {
        alert(data.message || 'Error al iniciar sesión');
      }
    } catch (e) {
      alert('Error de conexión con el servidor SIF');
    } finally {
      setLoading(false);
    }
  };

  const cargarDatos = async (mToken) => {
    try {
      const [resData, ctasData, credsData] = await Promise.all([
        mobileAPI.getResumen(mToken),
        mobileAPI.getCuentas(mToken),
        mobileAPI.getCreditos(mToken)
      ]);

      if (resData.success) setResumen(resData.data);
      if (ctasData.success) setCuentas(ctasData.data);
      if (credsData.success) setCreditos(credsData.data);
    } catch (e) {
      console.error(e);
    }
  };

  if (!token) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loginBox}>
          <Text style={styles.logoIcon}>🏦</Text>
          <Text style={styles.title}>SIF Banca Móvil</Text>
          <Text style={styles.subtitle}>Caja Popular México — Nivel Fintech</Text>

          <View style={styles.formGroup}>
            <Text style={styles.label}>Número de Socio</Text>
            <TextInput
              style={styles.input}
              value={numSocio}
              onChangeText={setNumSocio}
              placeholder="Ej. 35-178849"
              placeholderTextColor="#555"
            />
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>NIP / PIN de Seguridad</Text>
            <TextInput
              style={styles.input}
              value={pin}
              onChangeText={setPin}
              secureTextEntry
              placeholder="****"
              placeholderTextColor="#555"
            />
          </View>

          <TouchableOpacity style={styles.btnPrimary} onPress={handleLogin} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Ingresar a mi Cuenta</Text>}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.headerSub}>Bienvenido de nuevo</Text>
            <Text style={styles.headerName}>{resumen?.nombreSocio || 'Socio CPO'}</Text>
          </View>
          <TouchableOpacity onPress={() => setToken(null)} style={styles.btnLogout}>
            <Text style={styles.btnLogoutText}>🚪 Salir</Text>
          </TouchableOpacity>
        </View>

        {/* Card Saldo Principal */}
        <View style={styles.cardGold}>
          <Text style={styles.cardLabel}>Saldo Total Captación</Text>
          <Text style={styles.cardBalance}>${parseFloat(resumen?.totalAhorro || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</Text>
          <Text style={styles.cardNum}>Socio No. {resumen?.numSocio || numSocio}</Text>
        </View>

        {/* Cuentas & SPEI */}
        <Text style={styles.sectionTitle}>💳 Mis Cuentas & CLABE SPEI</Text>
        {cuentas.map((c, i) => (
          <View key={i} style={styles.itemCard}>
            <Text style={styles.itemTitle}>{c.producto}</Text>
            <Text style={styles.itemBalance}>${parseFloat(c.saldoDisponible || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</Text>
            <Text style={styles.itemClabe}>CLABE SPEI 24/7: {c.clabeSpei}</Text>
          </View>
        ))}

        {/* Créditos */}
        <Text style={styles.sectionTitle}>💰 Mis Créditos Activos</Text>
        {creditos.map((cr, i) => (
          <View key={i} style={styles.itemCard}>
            <Text style={styles.itemTitle}>{cr.producto} ({cr.folio})</Text>
            <Text style={styles.itemDeuda}>Deuda: ${parseFloat(cr.saldoCapital || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</Text>
            <Text style={styles.itemFecha}>Próximo Vencimiento: {new Date(cr.fechaVencimiento).toLocaleDateString('es-MX')}</Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0f19' },
  scrollContent: { padding: 20 },
  loginBox: { flex: 1, justifyContent: 'center', padding: 24 },
  logoIcon: { fontSize: 48, textAlign: 'center', marginBottom: 12 },
  title: { fontSize: 24, fontWeight: '800', color: '#c9a84c', textAlign: 'center' },
  subtitle: { fontSize: 13, color: '#8b949e', textAlign: 'center', marginBottom: 32 },
  formGroup: { marginBottom: 16 },
  label: { fontSize: 12, color: '#8b949e', textTransform: 'uppercase', marginBottom: 6, fontWeight: '600' },
  input: { backgroundColor: '#1c2333', borderColor: '#30363d', borderWidth: 1, borderRadius: 10, padding: 14, color: '#fff', fontSize: 16 },
  btnPrimary: { backgroundColor: '#1a6b8a', borderRadius: 10, padding: 16, alignItems: 'center', marginTop: 12 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  headerSub: { fontSize: 11, color: '#8b949e', textTransform: 'uppercase' },
  headerName: { fontSize: 20, fontWeight: '800', color: '#fff' },
  btnLogout: { backgroundColor: '#1c2333', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  btnLogoutText: { color: '#dc3545', fontWeight: '700', fontSize: 12 },
  cardGold: { background: '#1c2333', borderRadius: 16, padding: 20, marginBottom: 24, borderWidth: 1, borderColor: '#c9a84c' },
  cardLabel: { fontSize: 11, color: '#c9a84c', textTransform: 'uppercase' },
  cardBalance: { fontSize: 32, fontWeight: '900', color: '#fff', marginVertical: 6 },
  cardNum: { fontSize: 12, color: '#8b949e' },
  sectionTitle: { fontSize: 14, fontWeight: '800', color: '#c9a84c', marginTop: 16, marginBottom: 12 },
  itemCard: { backgroundColor: '#1c2333', borderWidth: 1, borderColor: '#30363d', borderRadius: 12, padding: 16, marginBottom: 12 },
  itemTitle: { fontSize: 14, fontWeight: '700', color: '#1e88b0' },
  itemBalance: { fontSize: 18, fontWeight: '800', color: '#28a745', marginVertical: 4 },
  itemClabe: { fontSize: 11, color: '#8b949e', fontFamily: 'monospace' },
  itemDeuda: { fontSize: 16, fontWeight: '800', color: '#dc3545', marginVertical: 4 },
  itemFecha: { fontSize: 11, color: '#8b949e' },
});

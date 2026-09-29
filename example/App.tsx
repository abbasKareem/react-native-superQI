import {
  configure,
  isAvailable,
  isSuperQiError,
  isSuperQiReturnUrl,
  pay,
  type SuperQiLanguage,
  type SuperQiPaymentMethod,
  type SuperQiPresentation,
} from "@morabaasoftwaresolutions/react-native-superqi";
import { StatusBar } from "expo-status-bar";
import { type ComponentProps, useEffect, useState } from "react";
import { Button, Linking, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";

// Matches "scheme" in app.json. On iOS the Super Qi app opens this URL to return to us.
const RETURN_URL = "superqiexample://superqi-return";

// Public gateway values may be prefilled from a git-ignored .env.local (see .env.example).
// Never put gateway credentials in an app: payment sessions are created by your backend.
const env = {
  baseUrl: process.env.EXPO_PUBLIC_SUPERQI_BASE_URL ?? "",
  terminalId: process.env.EXPO_PUBLIC_SUPERQI_TERMINAL_ID ?? "",
  publicKey: process.env.EXPO_PUBLIC_SUPERQI_PUBLIC_KEY ?? "",
};

export default function App() {
  const [baseUrl, setBaseUrl] = useState(env.baseUrl);
  const [terminalId, setTerminalId] = useState(env.terminalId);
  const [publicKey, setPublicKey] = useState(env.publicKey);
  const [merchantName, setMerchantName] = useState("SuperQi Example");
  const [language, setLanguage] = useState<SuperQiLanguage>("ar");
  const [presentation, setPresentation] = useState<SuperQiPresentation>("qr");

  // Paste these from a payment session your backend created (Qi "create payment" in app-channel mode).
  const [paymentId, setPaymentId] = useState("");
  const [requestId, setRequestId] = useState("");
  const [amount, setAmount] = useState("1000");
  const [currency, setCurrency] = useState("IQD");
  const [accountId, setAccountId] = useState("example-customer-1");
  const [method, setMethod] = useState<SuperQiPaymentMethod | undefined>(undefined);

  const [log, setLog] = useState<string[]>([]);
  const append = (line: string) => setLog((lines) => [`${new Date().toLocaleTimeString()}  ${line}`, ...lines].slice(0, 20));

  useEffect(() => {
    // Router-independent return handling: the SDK screen is still open when Super Qi returns and
    // reports the result itself, so the app only needs to avoid navigating on this URL.
    const subscription = Linking.addEventListener("url", ({ url }) => {
      append(isSuperQiReturnUrl(url, RETURN_URL) ? `Super Qi returned (${url}); waiting for the SDK result` : `Other link: ${url}`);
    });
    return () => subscription.remove();
  }, []);

  const run = async (label: string, action: () => Promise<string>) => {
    try {
      append(`${label}: ${await action()}`);
    } catch (error) {
      append(isSuperQiError(error) ? `${label} error ${error.code}: ${error.message}` : `${label} error: ${String(error)}`);
    }
  };

  const onConfigure = () =>
    run("configure", async () => {
      await configure({
        baseUrl,
        terminalId,
        publicKey,
        merchant: { name: merchantName },
        language,
        superQiPresentation: presentation,
        returnUrl: RETURN_URL,
      });
      return "ok";
    });

  const onPay = () =>
    run("pay", async () => {
      const result = await pay({ paymentId, requestId, amount: Number(amount), currency, accountId, method });
      // SDK-reported only. A real app now asks its backend for the confirmed status.
      return `sdkStatus=${result.sdkStatus}${result.message ? ` (${result.message})` : ""}; confirm with backend`;
    });

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.title}>Super Qi example</Text>
        <Text testID="availability">Native module: {isAvailable() ? "linked" : "not linked (rebuild the app; Expo Go cannot load it)"}</Text>
        <View style={styles.row}>
          <Button title="Configure" onPress={onConfigure} />
          <Button title="Pay" onPress={onPay} />
        </View>
        {log.slice(0, 5).map((line, index) => (
          <Text key={index} style={styles.log}>
            {line}
          </Text>
        ))}
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.section}>Gateway</Text>
        <Field label="Base URL" value={baseUrl} onChangeText={setBaseUrl} />
        <Field label="Terminal ID" value={terminalId} onChangeText={setTerminalId} />
        <Field label="Public key (PEM or base64)" value={publicKey} onChangeText={setPublicKey} multiline />
        <Field label="Merchant name" value={merchantName} onChangeText={setMerchantName} />
        <Toggle label="English (off = Arabic)" value={language === "en"} onValueChange={(on) => setLanguage(on ? "en" : "ar")} />
        <Toggle label="Super Qi link-first (off = QR-first)" value={presentation === "link"} onValueChange={(on) => setPresentation(on ? "link" : "qr")} />

        <Text style={styles.section}>Payment (from your backend)</Text>
        <Field label="paymentId" value={paymentId} onChangeText={setPaymentId} />
        <Field label="requestId" value={requestId} onChangeText={setRequestId} />
        <Field label="Amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
        <Field label="Currency" value={currency} onChangeText={setCurrency} />
        <Field label="Account ID" value={accountId} onChangeText={setAccountId} />
        <View style={styles.row}>
          {([undefined, "card", "superqi"] as const).map((option) => (
            <Button key={option ?? "chooser"} title={option ?? "SDK chooser"} color={method === option ? "#0a7" : undefined} onPress={() => setMethod(option)} />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function Field({ label, style, ...input }: { label: string } & ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput autoCapitalize="none" autoCorrect={false} style={[styles.input, style]} {...input} />
    </View>
  );
}

function Toggle(props: { label: string; value: boolean; onValueChange: (value: boolean) => void }) {
  return (
    <View style={styles.toggle}>
      <Text>{props.label}</Text>
      <Switch value={props.value} onValueChange={props.onValueChange} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  header: { paddingHorizontal: 16, paddingTop: 64, paddingBottom: 8, gap: 6, borderBottomWidth: 1, borderColor: "#ddd" },
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 8 },
  title: { fontSize: 22, fontWeight: "600" },
  section: { marginTop: 16, fontSize: 16, fontWeight: "600" },
  field: { gap: 4 },
  label: { color: "#555" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 8, maxHeight: 120 },
  toggle: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  log: { fontFamily: "Courier", fontSize: 12 },
});

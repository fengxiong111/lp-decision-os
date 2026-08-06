import os from "node:os";

export type LocalAccessInfo = {
  localUrl: string;
  lanUrl: string | null;
  lanIp: string | null;
};

function detectLanIp(): string | null {
  const override = process.env.LP_LAN_IP?.trim();
  if (override) return override;
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("127.")) return entry.address;
    }
  }
  return null;
}

export function getLocalAccessInfo(): LocalAccessInfo {
  const port = Number(process.env.LP_BACKEND_PORT ?? process.env.LP_PORT ?? 3838);
  const lanIp = process.env.LP_ENABLE_LAN === "1" ? detectLanIp() : null;
  return {
    localUrl: `http://localhost:${port}`,
    lanUrl: lanIp ? `http://${lanIp}:${port}` : null,
    lanIp,
  };
}

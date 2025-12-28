import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import https from 'node:https';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(process.cwd(), 'public');

let cachedLocation: string | null = null;

// Maintenance mode state
interface MaintenanceState {
  enabled: boolean;
  code: string;
  enabledAt: string | null;
}

const maintenanceState: MaintenanceState = {
  enabled: false,
  code: generateMaintenanceCode(),
  enabledAt: null,
};

// Connected servers tracking
interface ConnectedServer {
  id: string;
  address: string;
  connectedAt: string;
  lastPing: string;
}

const connectedServers = new Map<WebSocket, ConnectedServer>();
const healthEndpoints = new Set<WebSocket>();

// Generate a unique maintenance code
function generateMaintenanceCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Detect disk type (SSD, HDD, NVMe, etc.)
async function getDiskType(): Promise<string> {
  try {
    // Try to detect from /sys/block devices
    const devices = await fs.readdir('/sys/block');
    
    for (const device of devices) {
      if (device.startsWith('sd') || device.startsWith('vd') || device.startsWith('hd')) {
        try {
          // Check if it's rotational (HDD) or not (SSD)
          const rotationalPath = `/sys/block/${device}/queue/rotational`;
          const content = await fs.readFile(rotationalPath, 'utf8');
          if (content.trim() === '0') {
            return 'SSD';
          } else {
            return 'HDD';
          }
        } catch {
          continue;
        }
      } else if (device.startsWith('nvme')) {
        return 'NVMe';
      }
    }
  } catch {
    // Fallback
  }
  return 'Unknown';
}

// Detect RAM type (DDR3, DDR4, DDR5, etc.)
async function getRamType(): Promise<string> {
  try {
    // Try to get RAM type from dmidecode if available
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    
    try {
      const { stdout } = await execFileAsync('dmidecode', ['-t', 'memory'], { timeout: 5000 });
      
      // Look for Memory Type in dmidecode output
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.includes('Type:') && !line.includes('Type Detail')) {
          const match = line.match(/Type:\s*(.+)/i);
          if (match) {
            return match[1].trim();
          }
        }
      }
    } catch {
      // dmidecode might not be available or require root
    }
  } catch {
    // Fallback
  }
  return 'Unknown';
}

// Auto-detect location using geolocation API
async function getLocation(): Promise<string> {
  // Return cached location if available
  if (cachedLocation) {
    return cachedLocation;
  }

  try {
    const location = await new Promise<string>((resolve) => {
      https.get('https://ip-api.com/json/', (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.status === 'success') {
              const city = json.city || 'Unknown';
              const country = json.country || 'Unknown';
              const countryCode = json.countryCode || 'XX';
              const region = json.region || 'XX';
              // Format: "City, Country (CC-REGION-01)"
              const location = `${city}, ${country} (${countryCode}-${region}-01)`;
              cachedLocation = location;
              resolve(location);
            } else {
              resolve('Unknown Location');
            }
          } catch {
            resolve('Unknown Location');
          }
        });
      }).on('error', () => {
        resolve('Unknown Location');
      });
    });
    return location;
  } catch {
    return 'Unknown Location';
  }
}

// System info gathering functions
async function getSystemInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  const cpus = os.cpus();
  const cpuCount = cpus.length;
  
  // Calculate average CPU usage
  let totalIdle = 0;
  let totalTick = 0;
  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type as keyof typeof cpu.times];
    }
    totalIdle += cpu.times.idle;
  });
  const cpuUsage = 100 - Math.round((100 * totalIdle) / totalTick);
  
  // Get disk space info (root partition)
  let totalDisk = 0;
  let usedDisk = 0;
  try {
    const stats = await fs.statfs('/');
    totalDisk = stats.blocks * stats.bsize;
    usedDisk = (stats.blocks - stats.bavail) * stats.bsize;
  } catch (err) {
    // Fallback if statfs fails
    console.warn('Could not retrieve disk info:', err);
  }

  const location = await getLocation();
  const diskType = await getDiskType();
  const ramType = await getRamType();
  
  return {
    location: location,
    storage: {
      type: diskType,
      total: totalDisk,
      used: usedDisk,
      free: totalDisk - usedDisk,
      percent: totalDisk > 0 ? Math.round((usedDisk / totalDisk) * 100) : 0,
    },
    ram: {
      type: ramType,
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percent: Math.round((usedMem / totalMem) * 100),
    },
    cpu: {
      count: cpuCount,
      usage: cpuUsage,
      model: cpus[0]?.model || 'Unknown',
    },
    uptime: os.uptime(),
    timestamp: new Date().toISOString(),
  };
}

// Simple HTTP server to serve the client page
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  
  // Health check endpoint
  if (url.pathname === '/health') {
    try {
      const healthData = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: os.uptime(),
        memory: {
          total: os.totalmem(),
          free: os.freemem(),
          usage: Math.round((1 - os.freemem() / os.totalmem()) * 100),
        },
        connections: wss.clients.size,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(healthData, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'unhealthy', error: 'Health check failed' }));
    }
    return;
  }
  
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to load client page');
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// WebSocket server bound to the same HTTP server
const wss = new WebSocketServer({ server });

// Track liveness without mutating ws objects
const isAlive = new WeakMap<WebSocket, boolean>();

wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const clientAddr = req.socket.remoteAddress || 'unknown';
  
  // Generate unique server ID
  const serverId = `SRV-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

  // Handle health check endpoint - keep connection alive
  if (url.pathname === '/health') {
    console.log(`[ws-health] client connected from ${clientAddr}`);
    
    // Track this health endpoint connection
    healthEndpoints.add(ws);
    
    // Track liveness for health endpoint
    isAlive.set(ws, true);
    ws.on('pong', () => {
      isAlive.set(ws, true);
    });
    
    // Function to send health data
    const sendHealthData = async () => {
      try {
        // Get disk space info
        let totalDisk = 0;
        let usedDisk = 0;
        let diskType = 'Unknown';
        try {
          const stats = await fs.statfs('/');
          totalDisk = stats.blocks * stats.bsize;
          usedDisk = (stats.blocks - stats.bavail) * stats.bsize;
          diskType = await getDiskType();
        } catch {
          // Disk info unavailable
        }
        
        const healthData = {
          type: 'health_response',
          status: maintenanceState.enabled ? 'maintenance' : 'healthy',
          timestamp: new Date().toISOString(),
          uptime: os.uptime(),
          memory: {
            total: os.totalmem(),
            free: os.freemem(),
            usage: Math.round((1 - os.freemem() / os.totalmem()) * 100),
          },
          storage: {
            type: diskType,
            total: totalDisk,
            used: usedDisk,
            free: totalDisk - usedDisk,
            percent: totalDisk > 0 ? Math.round((usedDisk / totalDisk) * 100) : 0,
          },
          connections: wss.clients.size,
          maintenance: maintenanceState,
        };
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(healthData));
        }
      } catch (err) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'health_response', 
            status: 'unhealthy', 
            error: 'Health check failed' 
          }));
        }
      }
    };
    
    // Send initial health data
    sendHealthData();
    
    // Send health data every 1 minute
    const healthInterval = setInterval(sendHealthData, 60000);
    
    // Handle messages on health endpoint
    ws.on('message', async (data: RawData) => {
      sendHealthData();
    });
    
    ws.on('close', () => {
      console.log('[ws-health] client disconnected');
      healthEndpoints.delete(ws);
      clearInterval(healthInterval);
    });
    
    ws.on('error', (err: Error) => {
      console.error('[ws-health] error:', err.message);
      healthEndpoints.delete(ws);
      clearInterval(healthInterval);
    });
    
    return;
  }

  // Main WebSocket endpoint
  // Track liveness
  isAlive.set(ws, true);
  ws.on('pong', () => {
    isAlive.set(ws, true);
  });

  console.log(`[ws] client connected from ${clientAddr} [${serverId}]`);
  
  // Track connected server
  const serverInfo: ConnectedServer = {
    id: serverId,
    address: clientAddr,
    connectedAt: new Date().toISOString(),
    lastPing: new Date().toISOString(),
  };
  connectedServers.set(ws, serverInfo);

  // Send welcome message with maintenance status
  ws.send(JSON.stringify({ 
    type: 'welcome', 
    message: 'Connected to TypeScript WebSocket server',
    serverId: serverId,
    maintenance: maintenanceState,
  }));

  // Send system info on connection
  try {
    const systemInfo = await getSystemInfo();
    ws.send(JSON.stringify({ type: 'system_info', data: systemInfo }));
  } catch (err) {
    console.error('Error gathering system info:', err);
  }
  
  // Broadcast updated server list to all clients
  broadcastServerList();

  ws.on('message', async (data: RawData) => {
    let payload: any;
    try {
      payload = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());
    } catch {
      payload = { type: 'message', text: data.toString() };
    }
    
    // Update last ping time
    const server = connectedServers.get(ws);
    if (server) {
      server.lastPing = new Date().toISOString();
    }

    // Handle maintenance toggle
    if (payload.type === 'toggle_maintenance') {
      maintenanceState.enabled = !maintenanceState.enabled;
      if (maintenanceState.enabled) {
        maintenanceState.code = generateMaintenanceCode();
        maintenanceState.enabledAt = new Date().toISOString();
      } else {
        maintenanceState.enabledAt = null;
      }
      console.log(`[maintenance] ${maintenanceState.enabled ? 'ENABLED' : 'DISABLED'} - Code: ${maintenanceState.code}`);
      broadcastMaintenanceStatus();
      return;
    }

    // Handle health check requests
    if (payload.type === 'health') {
      try {
        const healthData = {
          type: 'health_response',
          status: maintenanceState.enabled ? 'maintenance' : 'healthy',
          timestamp: new Date().toISOString(),
          uptime: os.uptime(),
          memory: {
            total: os.totalmem(),
            free: os.freemem(),
            usage: Math.round((1 - os.freemem() / os.totalmem()) * 100),
          },
          connections: wss.clients.size,
          maintenance: maintenanceState,
        };
        ws.send(JSON.stringify(healthData));
      } catch (err) {
        ws.send(JSON.stringify({ 
          type: 'health_response', 
          status: 'unhealthy', 
          error: 'Health check failed' 
        }));
      }
      return;
    }
    
    // Request server list
    if (payload.type === 'get_servers') {
      ws.send(JSON.stringify({
        type: 'server_list',
        servers: Array.from(connectedServers.values()),
      }));
      return;
    }

    // Broadcast messages to all clients
    const out = JSON.stringify({ type: 'broadcast', from: clientAddr, payload });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(out);
      }
    }
  });

  ws.on('close', () => {
    const server = connectedServers.get(ws);
    if (server) {
      console.log(`[ws] client disconnected [${server.id}]`);
      connectedServers.delete(ws);
      broadcastServerList();
    } else {
      console.log('[ws] client disconnected');
    }
  });

  ws.on('error', (err: Error) => {
    console.error('[ws] error:', err.message);
  });
});

// Ping clients periodically; terminate dead connections
const interval = setInterval(() => {
  for (const ws of wss.clients) {
    const alive = isAlive.get(ws);
    if (alive === false) {
      ws.terminate();
      continue;
    }
    isAlive.set(ws, false);
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(interval));

// Broadcast maintenance status to all clients
function broadcastMaintenanceStatus() {
  const message = JSON.stringify({
    type: 'maintenance_update',
    maintenance: maintenanceState,
  });
  
  // Send to regular clients
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && !healthEndpoints.has(client)) {
      client.send(message);
    }
  }
  
  // Send immediate health update to health endpoint clients
  const healthData = {
    type: 'health_response',
    status: maintenanceState.enabled ? 'maintenance' : 'healthy',
    timestamp: new Date().toISOString(),
    uptime: os.uptime(),
    memory: {
      total: os.totalmem(),
      free: os.freemem(),
      usage: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    },
    storage: {
      type: 'Unknown',
      total: 0,
      used: 0,
      free: 0,
      percent: 0,
    },
    connections: wss.clients.size,
    maintenance: maintenanceState,
  };
  
  // Try to get disk info
  (async () => {
    try {
      const stats = await fs.statfs('/');
      healthData.storage.total = stats.blocks * stats.bsize;
      healthData.storage.used = (stats.blocks - stats.bavail) * stats.bsize;
      healthData.storage.free = healthData.storage.total - healthData.storage.used;
      healthData.storage.percent = healthData.storage.total > 0 ? Math.round((healthData.storage.used / healthData.storage.total) * 100) : 0;
      healthData.storage.type = await getDiskType();
    } catch {
      // Disk info unavailable
    }
    
    for (const healthClient of healthEndpoints) {
      if (healthClient.readyState === WebSocket.OPEN) {
        healthClient.send(JSON.stringify(healthData));
      }
    }
  })();
}

// Broadcast server list to all clients
function broadcastServerList() {
  const message = JSON.stringify({
    type: 'server_list',
    servers: Array.from(connectedServers.values()),
  });
  
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

server.listen(PORT, () => {
  console.log(`HTTP server listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint available at ws://localhost:${PORT}`);
  console.log(`Initial maintenance code: ${maintenanceState.code}`);
});

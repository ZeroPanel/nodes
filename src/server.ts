import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

// Import modular utilities
import { Logger } from './utils/logger';
import { getSystemInfo, generateMaintenanceCode, getDiskType } from './utils/system-info';
import { getConfig, updateDockerSocket } from './utils/config';
import {
  initDocker,
  getDockerContainers,
} from './events/docker-events';
import {
  handleCreateEndpoint,
  handleContainerInfoEndpoint,
  handleHealthEndpoint,
  handleMainEndpoint,
  connectedServers,
  healthEndpoints,
} from './events/ws-events';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(process.cwd(), 'public');

// Initialize Docker
(async () => {
  await initDocker();
})();

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

// Simple HTTP server to serve the client page
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  
  // Configuration endpoints
  if (url.pathname === '/api/config') {
    if (req.method === 'GET') {
      try {
        const config = await getConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to get configuration' }));
      }
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { socketPath, useDesktopSocket } = data;
          
          if (!socketPath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'socketPath is required' }));
            return;
          }
          
          await updateDockerSocket(socketPath, !!useDesktopSocket);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Docker socket configuration updated' }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to update configuration' }));
        }
      });
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
    return;
  }
  
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
  
  if (url.pathname === '/create') {
    try {
      const html = await readFile(path.join(PUBLIC_DIR, 'create.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to load create page');
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

// Handle WebSocket connections
wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const clientAddr = req.socket.remoteAddress || 'unknown';
  
  // Generate unique server ID
  const serverId = `SRV-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

  // Track liveness
  isAlive.set(ws, true);
  ws.on('pong', () => {
    isAlive.set(ws, true);
  });

  // Route to appropriate handler based on pathname
  console.log(`[server] WebSocket connection to: ${url.pathname}`);
  
  if (url.pathname === '/create') {
    console.log('[server] Routing to /create endpoint');
    await handleCreateEndpoint(ws, clientAddr);
    return;
  }

  // Allow both /containers/{id} and /container/{id}
  const containerInfoMatch = url.pathname.match(/^\/containers?\/([^/]+)$/);
  if (containerInfoMatch) {
    const containerId = containerInfoMatch[1];
    console.log(`[server] Routing to /containers/${containerId} endpoint`);
    console.log(`[/containers/${containerId} endpoint] Connection established from ${clientAddr}`);

    await handleContainerInfoEndpoint(ws, containerId, clientAddr);
    return;
  }

  if (url.pathname === '/health') {
    const getHealthData = async () => {
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
      
      return {
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
    };

    await handleHealthEndpoint(ws, clientAddr, getHealthData);
    return;
  }

  // Main endpoint
  console.log('[server] Routing to main endpoint');
  await handleMainEndpoint(
    ws,
    clientAddr,
    serverId,
    maintenanceState,
    broadcastServerList,
    broadcastMaintenanceStatus,
    broadcastContainerUpdate,
    getSystemInfo
  );
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
  
  // Send immediate health update to health endpoint clients (as stats format)
  const healthData = {
    type: 'container_stats',
    status: maintenanceState.enabled ? 'maintenance' : 'healthy',
    timestamp: new Date().toISOString(),
    uptime: os.uptime(),
    cpu: {
      usage: 0,
    },
    memory: {
      usage: os.totalmem() - os.freemem(),
      limit: os.totalmem(),
      percent: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    },
    disk: {
      read: 0,
      write: 0,
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

// Broadcast container updates to all clients
async function broadcastContainerUpdate() {
  const containers = await getDockerContainers();
  const message = JSON.stringify({
    type: 'container_list',
    containers: containers,
  });
  
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && !healthEndpoints.has(client)) {
      client.send(message);
    }
  }
}

// Start server
server.listen(PORT, () => {
  Logger.server(`HTTP server listening on http://localhost:${PORT}`);
  Logger.server(`WebSocket endpoint available at ws://localhost:${PORT}`);
  Logger.maintenance(`Initial maintenance code: ${maintenanceState.code}`);
});

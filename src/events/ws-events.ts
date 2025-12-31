/**
 * WebSocket event handlers
 */

import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { PassThrough } from 'node:stream';
import {
  getDocker,
  pullDockerImage,
  createContainer,
  stopContainer,
  startContainer,
  restartContainer,
  removeContainer,
  getContainerStatus,
  getContainerStats,
  getDockerContainers,
  getAvailableVolumes,
  getContainerVolumes,
  attachVolumeToContainer,
  listContainerFiles,
  readContainerFile,
  writeContainerFile,
  uploadFileToContainer,
  downloadFileFromContainer,
  createFileInContainer,
  createFolderInContainer,
  deleteFileOrFolderInContainer,
} from './docker-events';
import { Logger } from '../utils/logger';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface ConnectedServer {
  id: string;
  address: string;
  connectedAt: string;
  lastPing: string;
}

export const connectedServers = new Map<WebSocket, ConnectedServer>();
export const healthEndpoints = new Set<WebSocket>();

/**
 * Handle /create endpoint - Panel container creation
 */
export async function handleCreateEndpoint(ws: WebSocket, clientAddr: string): Promise<void> {
  Logger.ws('create', `Panel connected from ${clientAddr}`);
  
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connected to container creation endpoint',
    timestamp: new Date().toISOString(),
  }));
  
  ws.on('message', async (data: RawData) => {
    let payload: any;
    try {
      payload = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Invalid JSON format',
      }));
      return;
    }
    console.log('[/create endpoint] Payload received:', JSON.stringify(payload));
    
    if (payload.type === 'create_container') {
      const { name, image, ports, resources, user, description } = payload;
      
      if (!name || !image) {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Missing required fields: name and image are required',
        }));
        return;
      }
      
      try {
        // Create volume directory for the container
        const volumePath = path.join(process.cwd(), 'volumes', name);
        await fs.mkdir(volumePath, { recursive: true });
        Logger.success(`Volume directory created: ${volumePath}`);
        
        const exposedPorts: any = {};
        const portBindings: any = {};
        
        if (ports && Array.isArray(ports)) {
          ports.forEach((port: any) => {
            const containerPort = `${port.private}/tcp`;
            exposedPorts[containerPort] = {};
            portBindings[containerPort] = [{ HostPort: String(port.public) }];
          });
        }
        
        const hostConfig: any = {
          PortBindings: portBindings,
          Binds: [`${volumePath}:/nebula-data`],
        };
        
        if (resources) {
          if (resources.memoryLimit) {
            hostConfig.Memory = resources.memoryLimit * 1024 * 1024;
          }
          if (resources.cpuLimit) {
            hostConfig.NanoCpus = (resources.cpuLimit / 100) * 1e9;
          }
          // Note: StorageOpt (disk limits) requires overlay over xfs with pquota - not universally supported
        }
        
        const options = {
          Image: image,
          name: name,
          ExposedPorts: exposedPorts,
          Tty: true,
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Labels: {
            'nebula.user': user || 'unknown',
            'nebula.description': description || '',
            'nebula.created': new Date().toISOString(),
          },
          HostConfig: hostConfig,
        };
        
        const broadcastStatus = (msg: any) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
          }
        };
        
        const result = await createContainer(options, broadcastStatus);
        
        if (result.success) {
          ws.send(JSON.stringify({
            type: 'success',
            message: 'Container created successfully',
            containerId: result.containerId,
            containerName: name,
            timestamp: new Date().toISOString(),
          }));
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            error: result.error || 'Failed to create container',
          }));
        }
      } catch (err: any) {
        ws.send(JSON.stringify({
          type: 'error',
          error: err.message || 'Unknown error occurred',
        }));
      }
    } else {
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Unknown message type. Expected: create_container',
      }));
    }
  });
  
  ws.on('close', () => {
    Logger.ws('create', 'Panel disconnected');
  });
  
  ws.on('error', (err: Error) => {
    Logger.wsError('create', 'Error occurred:', err);
  });
}

/**
 * Handle /containers/{containerId} endpoint - Container info and logs
 */
export async function handleContainerInfoEndpoint(
  ws: WebSocket,
  containerId: string,
  clientAddr: string
): Promise<void> {
  Logger.ws('container-info', `Connected for container ${containerId} from ${clientAddr}`);
  
  let stopLogs: (() => void) | null = null;
  let statsInterval: NodeJS.Timeout | null = null;
  const docker = getDocker();
  
  // Ensure container volume directory exists
  const volumePath = path.join(process.cwd(), 'volumes', containerId);
  try {
    await fs.mkdir(volumePath, { recursive: true });
    Logger.success(`Volume directory created/verified: ${volumePath}`);
  } catch (err) {
    Logger.error(`Failed to create volume directory: ${volumePath}`, err as Error);
  }
  
  const sendStatus = async () => {
    const status = await getContainerStatus(containerId);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'container_status',
        containerId,
        ...status,
        timestamp: new Date().toISOString(),
      }));
    }
  };
  
  const sendStats = async () => {
    const stats = await getContainerStats(containerId);
    const status = await getContainerStatus(containerId);
    
    if (stats && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'container_stats',
        containerId,
        cpu: stats.cpu,
        memory: stats.memory,
        disk: stats.disk,
        uptime: status.details?.uptime || 0,
        timestamp: new Date().toISOString(),
      }));
    }
  };
  
  const startStatsStream = () => {
    if (statsInterval) clearInterval(statsInterval);
    
    // Send stats immediately
    sendStats();
    
    // Then send every 2 seconds
    statsInterval = setInterval(sendStats, 2000);
  };
  
  const startLogs = async (tail?: number, timestamps?: boolean) => {
    if (stopLogs) {
      try { stopLogs(); } catch {}
      stopLogs = null;
    }
    
    if (!docker) {
      ws.send(JSON.stringify({ type: 'error', error: 'Docker not available' }));
      return;
    }
    
    try {
      const container = docker.getContainer(containerId);
      const info = await container.inspect();
      const useDemux = !info.Config?.Tty;
      const logStream = await container.logs({ follow: true, stdout: true, stderr: true, tail: tail ?? 50, timestamps: !!timestamps });
      
      ws.send(JSON.stringify({ type: 'container_logs_start', containerId, tail: tail ?? 50, tty: info.Config?.Tty === true }));
      
      let stdoutPT: PassThrough | null = null;
      let stderrPT: PassThrough | null = null;
      
      const sendChunk = (streamName: 'stdout' | 'stderr', chunk: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'container_logs', containerId, stream: streamName, data: chunk.toString() }));
        }
      };
      
      if (useDemux) {
        stdoutPT = new PassThrough();
        stderrPT = new PassThrough();
        docker.modem.demuxStream(logStream, stdoutPT, stderrPT);
        stdoutPT.on('data', (chunk: Buffer) => sendChunk('stdout', chunk));
        stderrPT.on('data', (chunk: Buffer) => sendChunk('stderr', chunk));
      } else {
        logStream.on('data', (chunk: Buffer) => sendChunk('stdout', chunk));
      }
      
      const cleanup = () => {
        try { (logStream as any).destroy?.(); } catch {}
        try { stdoutPT?.destroy(); } catch {}
        try { stderrPT?.destroy(); } catch {}
      };
      
      logStream.on('end', () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'container_logs_end', containerId }));
        }
        cleanup();
      });
      
      logStream.on('error', (err: any) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'container_logs_error', containerId, error: err?.message || String(err) }));
        }
        cleanup();
      });
      
      stopLogs = cleanup;
    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', error: err?.message || 'Failed to stream logs' }));
    }
  };

  await sendStatus();
  await startLogs();
  startStatsStream();
  
  ws.on('message', async (data: RawData) => {
    let payload: any;
    try {
      payload = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON format' }));
      return;
    }
    console.log(`[/containers/${containerId} endpoint] Payload received:`, JSON.stringify(payload));
    if (payload.type === 'container_info') {
      await sendStatus();
      return;
    }
    
    if (payload.type === 'logs') {
      const tail = typeof payload.tail === 'number' ? payload.tail : 50;
      const timestamps = !!payload.timestamps;
      await startLogs(tail, timestamps);
      return;
    }
    
    if (payload.command) {
      try {
        if (!docker) {
          ws.send(JSON.stringify({ type: 'error', error: 'Docker not available' }));
          return;
        }
        
        const container = docker.getContainer(containerId);
        const cmd = typeof payload.command === 'string' ? ['/bin/sh', '-c', payload.command] : payload.command;
        
        const exec = await container.exec({
          Cmd: cmd,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
        });
        
        ws.send(JSON.stringify({ type: 'container_exec_start', containerId, command: payload.command }));
        
        const stream = await exec.start({ Tty: false });
        const stdoutPT = new PassThrough();
        const stderrPT = new PassThrough();
        
        docker.modem.demuxStream(stream, stdoutPT, stderrPT);
        
        stdoutPT.on('data', (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'container_exec_output', containerId, stream: 'stdout', data: chunk.toString() }));
          }
        });
        
        stderrPT.on('data', (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'container_exec_output', containerId, stream: 'stderr', data: chunk.toString() }));
          }
        });
        
        stream.on('end', async () => {
          try {
            const info = await exec.inspect();
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'container_exec_end', containerId, exitCode: info.ExitCode, command: payload.command }));
            }
          } catch (err) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'container_exec_end', containerId, exitCode: -1, error: 'Could not get exit code', command: payload.command }));
            }
          }
          try { stream.destroy(); } catch {}
          try { stdoutPT.destroy(); } catch {}
          try { stderrPT.destroy(); } catch {}
        });
        
        stream.on('error', (err: any) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'container_exec_error', containerId, error: err?.message || String(err), command: payload.command }));
          }
          try { stream.destroy(); } catch {}
          try { stdoutPT.destroy(); } catch {}
          try { stderrPT.destroy(); } catch {}
        });
      } catch (err: any) {
        ws.send(JSON.stringify({ type: 'error', error: err?.message || 'Failed to execute command' }));
      }
      return;
    }
    
    if (payload.event === 'start') {
      ws.send(JSON.stringify({ type: 'container_action_progress', action: 'start', status: 'starting', containerId }));
      const result = await startContainer(containerId);
      ws.send(JSON.stringify({ type: 'container_action_result', action: 'start', containerId, ...result }));
      await sendStatus();
      return;
    }
    
    if (payload.event === 'stop') {
      ws.send(JSON.stringify({ type: 'container_action_progress', action: 'stop', status: 'stopping', containerId }));
      const result = await stopContainer(containerId);
      ws.send(JSON.stringify({ type: 'container_action_result', action: 'stop', containerId, ...result }));
      await sendStatus();
      return;
    }
    
    if (payload.event === 'restart') {
      ws.send(JSON.stringify({ type: 'container_action_progress', action: 'restart', status: 'restarting', containerId }));
      const result = await restartContainer(containerId);
      ws.send(JSON.stringify({ type: 'container_action_result', action: 'restart', containerId, ...result }));
      await sendStatus();
      return;
    }
    
    if (payload.type === 'get_available_volumes') {
      const volumes = await getAvailableVolumes();
      ws.send(JSON.stringify({ type: 'available_volumes', volumes: volumes }));
      return;
    }
    
    if (payload.type === 'get_container_volumes') {
      const volumes = await getContainerVolumes(containerId);
      ws.send(JSON.stringify({ type: 'container_volumes', containerId, volumes: volumes }));
      return;
    }
    
    if (payload.type === 'attach_volume') {
      const { volumeName } = payload;
      if (!volumeName) {
        ws.send(JSON.stringify({ type: 'error', error: 'volumeName is required' }));
        return;
      }
      
      const result = await attachVolumeToContainer(containerId, volumeName);
      ws.send(JSON.stringify({ 
        type: 'volume_attachment_result', 
        containerId, 
        volumeName,
        ...result 
      }));
      
      if (result.success) {
        const volumes = await getContainerVolumes(containerId);
        ws.send(JSON.stringify({ type: 'container_volumes', containerId, volumes: volumes }));
      }
      return;
    }
    
    if (payload.type === 'list_files') {
      const containerPath = payload.path || '/';
      const result = await listContainerFiles(containerId, containerPath);
      ws.send(JSON.stringify({
        type: 'file_list',
        containerId,
        path: containerPath,
        ...result,
      }));
      return;
    }
    
    if (payload.type === 'read_file') {
      const { filePath } = payload;
      if (!filePath) {
        ws.send(JSON.stringify({ type: 'error', error: 'filePath is required' }));
        return;
      }
      
      const result = await readContainerFile(containerId, filePath);
      ws.send(JSON.stringify({
        type: 'file_content',
        containerId,
        filePath,
        ...result,
      }));
      return;
    }
    
    if (payload.type === 'write_file') {
      const { filePath, content } = payload;
      if (!filePath || content === undefined) {
        ws.send(JSON.stringify({ type: 'error', error: 'filePath and content are required' }));
        return;
      }
      
      const result = await writeContainerFile(containerId, filePath, content);
      ws.send(JSON.stringify({
        type: 'file_write_result',
        containerId,
        filePath,
        ...result,
      }));
      return;
    }
    
    if (payload.type === 'upload_file') {
      const { localPath, containerPath } = payload;
      if (!localPath || !containerPath) {
        ws.send(JSON.stringify({ type: 'error', error: 'localPath and containerPath are required' }));
        return;
      }
      
      const result = await uploadFileToContainer(containerId, localPath, containerPath);
      ws.send(JSON.stringify({
        type: 'file_upload_result',
        containerId,
        localPath,
        containerPath,
        ...result,
      }));
      return;
    }
    
    if (payload.type === 'download_file') {
      const { containerPath, localPath } = payload;
      if (!containerPath || !localPath) {
        ws.send(JSON.stringify({ type: 'error', error: 'containerPath and localPath are required' }));
        return;
      }
      
      const result = await downloadFileFromContainer(containerId, containerPath, localPath);
      ws.send(JSON.stringify({
        type: 'file_download_result',
        containerId,
        containerPath,
        localPath,
        ...result,
      }));
      return;
    }
    
    if (payload.type === 'create_file') {
      const { filePath } = payload;
      if (!filePath) {
        ws.send(JSON.stringify({ type: 'error', error: 'filePath is required' }));
        return;
      }
      
      const result = await createFileInContainer(containerId, filePath);
      ws.send(JSON.stringify({
        type: 'file_create_result',
        containerId,
        filePath,
        ...result,
      }));
      return;
    }
    
    if (payload.type === 'create_folder') {
      const { folderPath } = payload;
      if (!folderPath) {
        ws.send(JSON.stringify({ type: 'error', error: 'folderPath is required' }));
        return;
      }
      
      const result = await createFolderInContainer(containerId, folderPath);
      ws.send(JSON.stringify({
        type: 'folder_create_result',
        containerId,
        folderPath,
        ...result,
      }));
      return;
    }
    
    if (payload.type === 'delete_item') {
      const { itemPath, isFolder } = payload;
      if (!itemPath) {
        ws.send(JSON.stringify({ type: 'error', error: 'itemPath is required' }));
        return;
      }
      
      const result = await deleteFileOrFolderInContainer(containerId, itemPath, isFolder);
      ws.send(JSON.stringify({
        type: 'delete_result',
        containerId,
        itemPath,
        isFolder,
        ...result,
      }));
      return;
    }
    
    ws.send(JSON.stringify({ type: 'error', error: 'Unknown message. Expected: {type:"container_info"} or {event:"start|stop|restart"}' }));
  });
  
  ws.on('close', () => {
    if (stopLogs) {
      try { stopLogs(); } catch {}
      stopLogs = null;
    }
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }
    Logger.ws('container-info', `Disconnected for container ${containerId}`);
  });
  
  ws.on('error', () => {
    if (stopLogs) {
      try { stopLogs(); } catch {}
      stopLogs = null;
    }
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }
  });
}

/**
 * Handle /health endpoint - Keep connection alive with health data
 */
export async function handleHealthEndpoint(
  ws: WebSocket,
  clientAddr: string,
  getHealthData: () => Promise<any>
): Promise<void> {
  Logger.ws('health', `Client connected from ${clientAddr}`);
  
  healthEndpoints.add(ws);
  
  const sendHealthData = async () => {
    try {
      const healthData = await getHealthData();
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
  
  sendHealthData();
  
  const healthInterval = setInterval(sendHealthData, 60000);
  
  ws.on('message', async () => {
    console.log('[health endpoint] Ping received');
    sendHealthData();
  });
  
  ws.on('close', () => {
    Logger.ws('health', 'Client disconnected');
    healthEndpoints.delete(ws);
    clearInterval(healthInterval);
  });
  
  ws.on('error', (err: Error) => {
    Logger.wsError('health', 'Error occurred:', err);
    healthEndpoints.delete(ws);
    clearInterval(healthInterval);
  });
}

/**
 * Handle main WebSocket endpoint
 */
export async function handleMainEndpoint(
  ws: WebSocket,
  clientAddr: string,
  serverId: string,
  maintenanceState: any,
  broadcastServerList: () => void,
  broadcastMaintenanceStatus: () => void,
  broadcastContainerUpdate: () => void,
  getSystemInfo: () => Promise<any>
): Promise<void> {
  Logger.ws('main', `Client connected from ${clientAddr} [${serverId}]`);
  
  const serverInfo: ConnectedServer = {
    id: serverId,
    address: clientAddr,
    connectedAt: new Date().toISOString(),
    lastPing: new Date().toISOString(),
  };
  connectedServers.set(ws, serverInfo);

  ws.send(JSON.stringify({ 
    type: 'welcome', 
    message: 'Connected to TypeScript WebSocket server',
    serverId: serverId,
    maintenance: maintenanceState,
  }));

  try {
    const systemInfo = await getSystemInfo();
    ws.send(JSON.stringify({ type: 'system_info', data: systemInfo }));
  } catch (err) {
    Logger.error('Error gathering system info:', err as Error);
  }
  
  broadcastServerList();

  ws.on('message', async (data: RawData) => {
    let payload: any;
    try {
      payload = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());
    } catch {
      payload = { type: 'message', text: data.toString() };
    }
    console.log('[main endpoint] Payload received:', JSON.stringify(payload));
    
    const server = connectedServers.get(ws);
    if (server) {
      server.lastPing = new Date().toISOString();
    }

    if (payload.type === 'toggle_maintenance') {
      maintenanceState.enabled = !maintenanceState.enabled;
      if (maintenanceState.enabled) {
        maintenanceState.enabledAt = new Date().toISOString();
      } else {
        maintenanceState.enabledAt = null;
      }
      Logger.maintenance(`${maintenanceState.enabled ? 'ENABLED' : 'DISABLED'} - Code: ${maintenanceState.code}`);
      broadcastMaintenanceStatus();
      return;
    }

    if (payload.type === 'health') {
      try {
        const healthData = {
          type: 'health_response',
          status: maintenanceState.enabled ? 'maintenance' : 'healthy',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          memory: {
            total: require('os').totalmem(),
            free: require('os').freemem(),
            usage: Math.round((1 - require('os').freemem() / require('os').totalmem()) * 100),
          },
          connections: 0,
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
    
    if (payload.type === 'get_servers') {
      ws.send(JSON.stringify({
        type: 'server_list',
        servers: Array.from(connectedServers.values()),
      }));
      return;
    }
    
    if (payload.type === 'get_containers') {
      const containers = await getDockerContainers();
      ws.send(JSON.stringify({
        type: 'container_list',
        containers: containers,
      }));
      return;
    }
    
    if (payload.type === 'create_container') {
      let options;
      
      if (payload.options) {
        options = payload.options;
      } else {
        const { name, image, ports, resources, user, description } = payload;
        
        // Create volume directory for the container
        const volumePath = path.join(process.cwd(), 'volumes', name);
        await fs.mkdir(volumePath, { recursive: true });
        Logger.success(`Volume directory created: ${volumePath}`);
        
        const exposedPorts: any = {};
        const portBindings: any = {};
        
        if (ports && Array.isArray(ports)) {
          ports.forEach((port: any) => {
            const containerPort = `${port.private}/tcp`;
            exposedPorts[containerPort] = {};
            portBindings[containerPort] = [{ HostPort: String(port.public) }];
          });
        }
        
        const hostConfig: any = {
          PortBindings: portBindings,
          Binds: [`${volumePath}:/nebula-data`],
        };
        
        if (resources) {
          if (resources.memoryLimit) {
            hostConfig.Memory = resources.memoryLimit * 1024 * 1024;
          }
          if (resources.cpuLimit) {
            hostConfig.NanoCpus = (resources.cpuLimit / 100) * 1e9;
          }
          // Note: StorageOpt (disk limits) requires overlay over xfs with pquota - not universally supported
        }
        
        options = {
          Image: image,
          name: name,
          ExposedPorts: exposedPorts,
          Tty: true,
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Labels: {
            'nebula.user': user || 'unknown',
            'nebula.description': description || '',
            'nebula.created': new Date().toISOString(),
          },
          HostConfig: hostConfig,
        };
      }
      
      const broadcastStatus = (msg: any) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      };
      
      const result = await createContainer(options, broadcastStatus);
      ws.send(JSON.stringify({
        type: 'container_action_result',
        action: 'create',
        ...result,
      }));
      broadcastContainerUpdate();
      return;
    }
    
    if (payload.type === 'stop_container') {
      const result = await stopContainer(payload.containerId);
      ws.send(JSON.stringify({
        type: 'container_action_result',
        action: 'stop',
        ...result,
      }));
      broadcastContainerUpdate();
      return;
    }
    
    if (payload.type === 'start_container') {
      const result = await startContainer(payload.containerId);
      ws.send(JSON.stringify({
        type: 'container_action_result',
        action: 'start',
        ...result,
      }));
      broadcastContainerUpdate();
      return;
    }
    
    if (payload.type === 'remove_container') {
      const result = await removeContainer(payload.containerId);
      ws.send(JSON.stringify({
        type: 'container_action_result',
        action: 'remove',
        ...result,
      }));
      broadcastContainerUpdate();
      return;
    }
    
    if (payload.type === 'get_available_volumes') {
      const volumes = await getAvailableVolumes();
      ws.send(JSON.stringify({ type: 'available_volumes', volumes: volumes }));
      return;
    }
    
    if (payload.type === 'get_container_volumes') {
      const { containerId } = payload;
      if (!containerId) {
        ws.send(JSON.stringify({ type: 'error', error: 'containerId is required' }));
        return;
      }
      const volumes = await getContainerVolumes(containerId);
      ws.send(JSON.stringify({ type: 'container_volumes', containerId, volumes: volumes }));
      return;
    }
    
    if (payload.type === 'attach_volume') {
      const { containerId, volumeName } = payload;
      if (!containerId || !volumeName) {
        ws.send(JSON.stringify({ type: 'error', error: 'containerId and volumeName are required' }));
        return;
      }
      
      const result = await attachVolumeToContainer(containerId, volumeName);
      ws.send(JSON.stringify({ 
        type: 'volume_attachment_result', 
        containerId, 
        volumeName,
        ...result 
      }));
      
      if (result.success) {
        const volumes = await getContainerVolumes(containerId);
        ws.send(JSON.stringify({ type: 'container_volumes', containerId, volumes: volumes }));
        broadcastContainerUpdate();
      }
      return;
    }
    
    if (payload.type === 'list_files') {
      const { containerId, path: containerPath } = payload;
      if (!containerId) {
        ws.send(JSON.stringify({ type: 'error', error: 'containerId is required' }));
        return;
      }
      
      const result = await listContainerFiles(containerId, containerPath || '/');
      ws.send(JSON.stringify({
        type: 'file_list',
        containerId,
        path: containerPath || '/',
        ...result,
      }));
      return;
    }
    
    if (payload.type === 'read_file') {
      const { containerId, filePath } = payload;
      if (!containerId || !filePath) {
        ws.send(JSON.stringify({ type: 'error', error: 'containerId and filePath are required' }));
        return;
      }
      
      const result = await readContainerFile(containerId, filePath);
      ws.send(JSON.stringify({
        type: 'file_content',
        containerId,
        filePath,
        ...result,
      }));
      return;
    }
    
    if (payload.type === 'write_file') {
      const { containerId, filePath, content } = payload;
      if (!containerId || !filePath || content === undefined) {
        ws.send(JSON.stringify({ type: 'error', error: 'containerId, filePath, and content are required' }));
        return;
      }
      
      const result = await writeContainerFile(containerId, filePath, content);
      ws.send(JSON.stringify({
        type: 'file_write_result',
        containerId,
        filePath,
        ...result,
      }));
      return;
    }
    
    if (payload.type === 'create_file') {
      const { containerId, filePath } = payload;
      if (!containerId || !filePath) {
        ws.send(JSON.stringify({ type: 'error', error: 'containerId and filePath are required' }));
        return;
      }
      
      const result = await createFileInContainer(containerId, filePath);
      ws.send(JSON.stringify({
        type: 'file_create_result',
        containerId,
        filePath,
        ...result,
      }));
      return;
    }
    
    if (payload.type === 'create_folder') {
      const { containerId, folderPath } = payload;
      if (!containerId || !folderPath) {
        ws.send(JSON.stringify({ type: 'error', error: 'containerId and folderPath are required' }));
        return;
      }
      
      const result = await createFolderInContainer(containerId, folderPath);
      ws.send(JSON.stringify({
        type: 'folder_create_result',
        containerId,
        folderPath,
        ...result,
      }));
      return;
    }
    
    if (payload.type === 'delete_item') {
      const { containerId, itemPath, isFolder } = payload;
      if (!containerId || !itemPath) {
        ws.send(JSON.stringify({ type: 'error', error: 'containerId and itemPath are required' }));
        return;
      }
      
      const result = await deleteFileOrFolderInContainer(containerId, itemPath, isFolder);
      ws.send(JSON.stringify({
        type: 'delete_result',
        containerId,
        itemPath,
        isFolder,
        ...result,
      }));
      return;
    }

    const out = JSON.stringify({ type: 'broadcast', from: clientAddr, payload });
    // Would broadcast to all clients here
  });

  ws.on('close', () => {
    const server = connectedServers.get(ws);
    if (server) {
      Logger.ws('main', `Client disconnected [${server.id}]`);
      connectedServers.delete(ws);
      broadcastServerList();
    } else {
      Logger.ws('main', 'Client disconnected');
    }
  });

  ws.on('error', (err: Error) => {
    Logger.wsError('main', 'Error occurred:', err);
  });
}

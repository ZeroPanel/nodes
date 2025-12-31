/**
 * Docker container management and event handlers
 */

import Docker from 'dockerode';
import { Logger } from '../utils/logger';
import { initializeDockerConfig } from '../utils/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Docker client
let docker: Docker;

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string[];
  created: number;
  user?: string;
  description?: string;
  resources?: {
    cpuLimit?: number;
    memoryLimit?: number;
  };
}

const containerCache = new Map<string, ContainerInfo>();

// Initialize Docker client
export async function initDocker(): Promise<Docker | null> {
  try {
    // Initialize Docker configuration and get socket path
    const socketPath = await initializeDockerConfig();
    
    if (socketPath) {
      Logger.info(`Connecting to Docker via: ${socketPath}`);
      docker = new Docker({ socketPath });
      
      // Test the connection
      try {
        const version = await docker.version();
        Logger.success(`Docker connected successfully (version: ${version.Version})`);
        return docker;
      } catch (connErr: any) {
        Logger.warn(`Could not connect to Docker at ${socketPath}: ${connErr.message}`);
        Logger.warn('Attempting to fallback to alternative socket...');
        
        // Try the other socket if the configured one fails
        const altPath = socketPath === '/var/run/docker.sock' 
          ? path.join(os.homedir(), '.docker', 'desktop', 'docker.sock')
          : '/var/run/docker.sock';
        
        try {
          const altDocker = new Docker({ socketPath: altPath });
          await altDocker.version();
          Logger.success(`Successfully connected to Docker at ${altPath}`);
          docker = altDocker;
          return docker;
        } catch (altErr) {
          Logger.error(`Failed to connect to both sockets`);
          return null;
        }
      }
    } else {
      Logger.warn('No Docker socket found. Attempting default connection...');
      docker = new Docker();
      try {
        await docker.version();
        Logger.success('Docker client initialized with default settings');
        return docker;
      } catch (err) {
        Logger.error('Could not connect to Docker with default settings');
        return null;
      }
    }
  } catch (err) {
    Logger.dockerError('Docker daemon not available. Container management disabled.', err as Error);
    return null;
  }
}

export function getDocker(): Docker | null {
  return docker;
}

// Get available volumes from the volumes directory
export async function getAvailableVolumes(): Promise<string[]> {
  try {
    const volumesDir = path.join(process.cwd(), 'volumes');
    const dirs = await fs.readdir(volumesDir, { withFileTypes: true });
    return dirs
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
  } catch (err) {
    Logger.warn('Could not read volumes directory:', err as Error);
    return [];
  }
}

// Attach volume to container
export async function attachVolumeToContainer(
  containerId: string,
  volumeName: string
): Promise<{ success: boolean; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    const volumePath = path.join(process.cwd(), 'volumes', volumeName);
    
    // Check if volume directory exists
    try {
      await fs.access(volumePath);
    } catch {
      return { success: false, error: `Volume directory does not exist: ${volumePath}` };
    }
    
    // Get container info
    const info = await container.inspect();
    
    // Add new bind mount to existing mounts
    const binds = (info.HostConfig?.Binds || []) as string[];
    const newBind = `${volumePath}:/nebula-volumes/${volumeName}`;
    
    // Check if volume is already attached
    if (binds.some(b => b.includes(volumeName))) {
      return { success: false, error: `Volume ${volumeName} is already attached to this container` };
    }
    
    binds.push(newBind);
    
    // Update container with new binds
    await container.update({ HostConfig: { Binds: binds } });
    Logger.success(`Volume ${volumeName} attached to container ${containerId}`);
    
    return { success: true };
  } catch (err: any) {
    Logger.dockerError(`Error attaching volume to container:`, err);
    return { success: false, error: err.message };
  }
}

// Get volumes attached to a container
export async function getContainerVolumes(containerId: string): Promise<string[]> {
  if (!docker) return [];
  
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    const binds = (info.HostConfig?.Binds || []) as string[];
    
    // Extract volume names from bind mounts
    return binds
      .filter(b => b.includes('/nebula-volumes/'))
      .map(b => {
        const match = b.match(/\/nebula-volumes\/(.+?)$/);
        return match ? match[1] : b;
      });
  } catch (err) {
    Logger.warn(`Could not get volumes for container ${containerId}:`, err as Error);
    return [];
  }
}

// Pull Docker image
export async function pullDockerImage(
  imageName: string,
  broadcastStatus?: (msg: any) => void
): Promise<{ success: boolean; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    Logger.docker(`Pulling image: ${imageName}`);
    if (broadcastStatus) broadcastStatus({ type: 'image_pull_start', image: imageName, status: 'pulling' });
    
    const stream = await docker.pull(imageName);
    
    return new Promise((resolve) => {
      docker.modem.followProgress(stream, (err: any, res: any) => {
        if (err) {
          Logger.dockerError(`Error pulling image ${imageName}:`, err);
          if (broadcastStatus) broadcastStatus({ type: 'image_pull_error', image: imageName, status: 'error', error: err.message });
          resolve({ success: false, error: err.message });
        } else {
          Logger.success(`Image pulled successfully: ${imageName}`);
          if (broadcastStatus) broadcastStatus({ type: 'image_pull_complete', image: imageName, status: 'complete' });
          resolve({ success: true });
        }
      }, (event: any) => {
        if (event.status) {
          Logger.docker(`Pull progress [${imageName}]: ${event.status}`);
          if (broadcastStatus) {
            broadcastStatus({ 
              type: 'image_pull_progress', 
              image: imageName, 
              status: event.status,
              id: event.id,
              progress: event.progressDetail?.current && event.progressDetail?.total ? 
                Math.round((event.progressDetail.current / event.progressDetail.total) * 100) : undefined
            });
          }
        }
      });
    });
  } catch (err: any) {
    Logger.dockerError(`Error pulling image ${imageName}:`, err);
    if (broadcastStatus) broadcastStatus({ type: 'image_pull_error', image: imageName, status: 'error', error: err.message });
    return { success: false, error: err.message };
  }
}

// Get Docker containers
export async function getDockerContainers(): Promise<ContainerInfo[]> {
  if (!docker) return [];
  
  try {
    const containers = await docker.listContainers({ all: true });
    return containers.map(c => {
      const containerInfo: ContainerInfo = {
        id: c.Id.substring(0, 12),
        name: c.Names[0]?.replace('/', '') || 'unknown',
        image: c.Image,
        status: c.State,
        ports: c.Ports.map(p => `${p.IP || '0.0.0.0'}:${p.PublicPort}` || 'internal').filter(p => p !== 'internal'),
        created: c.Created,
      };
      
      if (c.Labels) {
        if (c.Labels['nebula.user']) {
          containerInfo.user = c.Labels['nebula.user'];
        }
        if (c.Labels['nebula.description']) {
          containerInfo.description = c.Labels['nebula.description'];
        }
      }
      
      return containerInfo;
    });
  } catch (err) {
    Logger.dockerError('Error listing containers:', err as Error);
    return [];
  }
}

// Create container
export async function createContainer(
  options: any,
  broadcastStatus?: (msg: any) => void
): Promise<{ success: boolean; containerId?: string; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const imageName = options.Image;
    Logger.docker(`Pulling image: ${imageName}`);
    
    const pullResult = await pullDockerImage(imageName, broadcastStatus);
    if (!pullResult.success) {
      Logger.warn(`Warning pulling image ${imageName}: ${pullResult.error}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    if (broadcastStatus) broadcastStatus({ type: 'container_create_start', image: imageName, status: 'creating' });
    
    const container = await docker.createContainer(options);
    
    // Attach matching volumes to the container
    const containerName = options.name || container.id.substring(0, 12);
    const availableVolumes = await getAvailableVolumes();
    const attachedVolumes = [];
    
    for (const volumeName of availableVolumes) {
      try {
        const volumePath = path.join(process.cwd(), 'volumes', volumeName);
        const currentBinds = (options.HostConfig?.Binds || []) as string[];
        
        // Add new volume mount
        const newBind = `${volumePath}:/nebula-volumes/${volumeName}`;
        if (!currentBinds.includes(newBind)) {
          currentBinds.push(newBind);
          options.HostConfig.Binds = currentBinds;
          Logger.success(`Volume ${volumeName} prepared for attachment`);
          attachedVolumes.push(volumeName);
        }
      } catch (err) {
        Logger.warn(`Could not attach volume ${volumeName}:`, err as Error);
      }
    }
    
    if (attachedVolumes.length > 0 && broadcastStatus) {
      broadcastStatus({ 
        type: 'volumes_attached', 
        containerId: container.id.substring(0, 12), 
        volumes: attachedVolumes,
        status: 'volumes_ready'
      });
    }
    
    await container.start();
    Logger.success(`Container created: ${container.id.substring(0, 12)}`);
    
    if (broadcastStatus) broadcastStatus({ type: 'container_create_complete', containerId: container.id.substring(0, 12), status: 'complete' });
    
    return { success: true, containerId: container.id.substring(0, 12) };
  } catch (err: any) {
    Logger.dockerError('Error creating container:', err);
    if (broadcastStatus) broadcastStatus({ type: 'container_create_error', status: 'error', error: err.message });
    return { success: false, error: err.message };
  }
}

// Stop container
export async function stopContainer(containerId: string): Promise<{ success: boolean; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    await container.stop();
    Logger.success(`Container stopped: ${containerId}`);
    return { success: true };
  } catch (err: any) {
    Logger.dockerError(`Error stopping container: ${containerId}`, err);
    return { success: false, error: err.message };
  }
}

// Start container
export async function startContainer(containerId: string): Promise<{ success: boolean; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    
    // Ensure volumes are attached before starting
    const availableVolumes = await getAvailableVolumes();
    const info = await container.inspect();
    const currentBinds = (info.HostConfig?.Binds || []) as string[];
    
    for (const volumeName of availableVolumes) {
      const volumePath = path.join(process.cwd(), 'volumes', volumeName);
      const newBind = `${volumePath}:/nebula-volumes/${volumeName}`;
      
      if (!currentBinds.some(b => b.includes(volumeName))) {
        try {
          currentBinds.push(newBind);
          Logger.docker(`Adding volume ${volumeName} to container ${containerId}`);
        } catch (err) {
          Logger.warn(`Could not add volume ${volumeName}:`, err as Error);
        }
      }
    }
    
    // Update container with all binds
    if (currentBinds.length > 0) {
      try {
        await container.update({ HostConfig: { Binds: currentBinds } });
        Logger.success(`Volumes attached to container ${containerId}`);
      } catch (err) {
        Logger.warn(`Could not update container binds:`, err as Error);
      }
    }
    
    await container.start();
    Logger.success(`Container started: ${containerId}`);
    return { success: true };
  } catch (err: any) {
    Logger.dockerError(`Error starting container: ${containerId}`, err);
    return { success: false, error: err.message };
  }
}

// Restart container
export async function restartContainer(containerId: string): Promise<{ success: boolean; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    await container.restart();
    Logger.success(`Container restarted: ${containerId}`);
    return { success: true };
  } catch (err: any) {
    Logger.dockerError(`Error restarting container: ${containerId}`, err);
    return { success: false, error: err.message };
  }
}

// Remove container
export async function removeContainer(containerId: string): Promise<{ success: boolean; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    await container.remove({ force: true });
    Logger.success(`Container removed: ${containerId}`);
    return { success: true };
  } catch (err: any) {
    Logger.dockerError(`Error removing container: ${containerId}`, err);
    return { success: false, error: err.message };
  }
}

// Get container stats (CPU, memory, disk I/O)
export async function getContainerStats(containerId: string): Promise<any> {
  if (!docker) return null;
  
  try {
    const container = docker.getContainer(containerId);
    const stats = await container.stats({ stream: false });
    
    // Calculate CPU usage
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100 : 0;
    
    // Memory usage
    const memoryUsage = stats.memory_stats.usage || 0;
    const memoryLimit = stats.memory_stats.limit || 0;
    
    // Disk I/O
    const blkRead = stats.blkio_stats?.io_service_bytes_recursive?.find((item: any) => item.op === 'read')?.value || 0;
    const blkWrite = stats.blkio_stats?.io_service_bytes_recursive?.find((item: any) => item.op === 'write')?.value || 0;
    
    return {
      cpu: {
        usage: Math.round(cpuPercent * 100) / 100,
      },
      memory: {
        usage: memoryUsage,
        limit: memoryLimit,
        percent: memoryLimit > 0 ? Math.round((memoryUsage / memoryLimit) * 100) : 0,
      },
      disk: {
        read: blkRead,
        write: blkWrite,
      },
    };
  } catch (err: any) {
    Logger.dockerError('Error getting container stats:', err);
    return null;
  }
}

// Get container status
export async function getContainerStatus(
  containerId: string
): Promise<{ status: 'online' | 'stopped' | 'starting' | 'building' | 'paused' | 'removing' | 'error'; message: string; state?: string; details?: any }> {
  if (!docker) return { status: 'error', message: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    const stateText = info.State.Status || 'unknown';
    const baseDetails = {
      state: stateText,
      startedAt: info.State.StartedAt,
      finishedAt: info.State.FinishedAt,
      restartCount: info.RestartCount,
      health: info.State.Health || undefined,
    };
    
    if (info.State.Running) {
      return {
        status: 'online',
        message: 'Container is running',
        state: stateText,
        details: {
          ...baseDetails,
          pid: info.State.Pid,
          uptime: Math.floor((Date.now() - new Date(info.State.StartedAt).getTime()) / 1000),
        }
      };
    }
    
    if (info.State.Restarting || stateText === 'restarting') {
      return {
        status: 'starting',
        message: 'Container is restarting',
        state: stateText,
        details: baseDetails,
      };
    }
    
    if (stateText === 'created') {
      return {
        status: 'building',
        message: 'Container created and waiting to start',
        state: stateText,
        details: baseDetails,
      };
    }
    
    if (stateText === 'paused') {
      return {
        status: 'paused',
        message: 'Container is paused',
        state: stateText,
        details: baseDetails,
      };
    }
    
    if (stateText === 'removing') {
      return {
        status: 'removing',
        message: 'Container is being removed',
        state: stateText,
        details: baseDetails,
      };
    }
    
    if (stateText === 'dead') {
      return {
        status: 'error',
        message: 'Container is dead',
        state: stateText,
        details: baseDetails,
      };
    }
    
    return {
      status: 'stopped',
      message: 'Container is stopped',
      state: stateText,
      details: {
        ...baseDetails,
        exitCode: info.State.ExitCode,
        error: info.State.Error || undefined,
      }
    };
  } catch (err: any) {
    Logger.dockerError(`Error getting container status:`, err);
    return { status: 'error', message: `Error: ${err.message}` };
  }
}

// List files in a container directory
export async function listContainerFiles(
  containerId: string,
  containerPath: string = '/'
): Promise<{ success: boolean; files?: any[]; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    
    // Execute ls -la command to list files
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', `ls -la "${containerPath}" 2>/dev/null || ls -la /`],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    
    const stream = await exec.start({ Tty: false });
    
    return new Promise((resolve) => {
      let output = '';
      
      stream.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      
      stream.on('end', async () => {
        try {
          const info = await exec.inspect();
          if (info.ExitCode !== 0) {
            resolve({ success: false, error: 'Failed to list files' });
            return;
          }
          
          // Parse ls output
          const lines = output.split('\n').filter(l => l.trim());
          const files = lines.slice(1).map(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 9) return null;
            
            return {
              permissions: parts[0],
              links: parts[1],
              owner: parts[2],
              group: parts[3],
              size: parseInt(parts[4]) || 0,
              month: parts[5],
              day: parts[6],
              time: parts[7],
              name: parts.slice(8).join(' '),
              isDirectory: parts[0].startsWith('d'),
              isSymlink: parts[0].startsWith('l'),
            };
          }).filter(f => f !== null && f.name !== '.' && f.name !== '..');
          
          resolve({ success: true, files });
        } catch (err) {
          resolve({ success: false, error: 'Failed to parse file list' });
        }
      });
      
      stream.on('error', () => {
        resolve({ success: false, error: 'Stream error' });
      });
    });
  } catch (err: any) {
    Logger.dockerError('Error listing container files:', err);
    return { success: false, error: err.message };
  }
}

// Upload file to container
export async function uploadFileToContainer(
  containerId: string,
  localPath: string,
  containerPath: string
): Promise<{ success: boolean; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    
    // Read the file
    const fileData = await fs.readFile(localPath);
    
    // Create tar archive
    const tar = await import('tar-stream');
    const pack = tar.pack();
    
    const fileName = path.basename(localPath);
    const stats = await fs.stat(localPath);
    
    pack.entry({ name: fileName, size: stats.size }, fileData, (err) => {
      if (err) throw err;
      pack.finalize();
    });
    
    // Upload to container
    await container.putArchive(pack, { path: containerPath });
    Logger.success(`File uploaded to container ${containerId}: ${containerPath}/${fileName}`);
    
    return { success: true };
  } catch (err: any) {
    Logger.dockerError('Error uploading file to container:', err);
    return { success: false, error: err.message };
  }
}

// Download file from container
export async function downloadFileFromContainer(
  containerId: string,
  containerPath: string,
  localPath: string
): Promise<{ success: boolean; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    
    // Get file from container as tar stream
    const stream = await container.getArchive({ path: containerPath });
    
    // Extract tar archive
    const tar = await import('tar-stream');
    const extract = tar.extract();
    
    return new Promise((resolve) => {
      let fileData = Buffer.alloc(0);
      
      extract.on('entry', (header, entryStream, next) => {
        const chunks: Buffer[] = [];
        
        entryStream.on('data', (chunk) => {
          chunks.push(chunk);
        });
        
        entryStream.on('end', () => {
          fileData = Buffer.concat(chunks);
          next();
        });
        
        entryStream.resume();
      });
      
      extract.on('finish', async () => {
        try {
          await fs.writeFile(localPath, fileData);
          Logger.success(`File downloaded from container ${containerId}: ${containerPath} -> ${localPath}`);
          resolve({ success: true });
        } catch (err: any) {
          resolve({ success: false, error: err.message });
        }
      });
      
      extract.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
      
      stream.pipe(extract);
    });
  } catch (err: any) {
    Logger.dockerError('Error downloading file from container:', err);
    return { success: false, error: err.message };
  }
}

// Read file content from container (text files)
export async function readContainerFile(
  containerId: string,
  containerPath: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', `cat "${containerPath}"`],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    
    const stream = await exec.start({ Tty: false });
    
    return new Promise((resolve) => {
      let content = '';
      
      stream.on('data', (chunk: Buffer) => {
        content += chunk.toString();
      });
      
      stream.on('end', async () => {
        try {
          const info = await exec.inspect();
          if (info.ExitCode !== 0) {
            resolve({ success: false, error: 'Failed to read file' });
            return;
          }
          resolve({ success: true, content });
        } catch (err) {
          resolve({ success: false, error: 'Failed to read file' });
        }
      });
      
      stream.on('error', () => {
        resolve({ success: false, error: 'Stream error' });
      });
    });
  } catch (err: any) {
    Logger.dockerError('Error reading container file:', err);
    return { success: false, error: err.message };
  }
}

// Write file content to container (text files)
export async function writeContainerFile(
  containerId: string,
  containerPath: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    
    // Escape content for shell
    const escapedContent = content.replace(/'/g, "'\\''");
    
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', `echo '${escapedContent}' > "${containerPath}"`],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    
    const stream = await exec.start({ Tty: false });
    
    return new Promise((resolve) => {
      stream.on('end', async () => {
        try {
          const info = await exec.inspect();
          if (info.ExitCode !== 0) {
            resolve({ success: false, error: 'Failed to write file' });
            return;
          }
          Logger.success(`File written to container ${containerId}: ${containerPath}`);
          resolve({ success: true });
        } catch (err) {
          resolve({ success: false, error: 'Failed to write file' });
        }
      });
      
      stream.on('error', () => {
        resolve({ success: false, error: 'Stream error' });
      });
    });
  } catch (err: any) {
    Logger.dockerError('Error writing container file:', err);
    return { success: false, error: err.message };
  }
}

// Create a new empty file in container
export async function createFileInContainer(
  containerId: string,
  filePath: string
): Promise<{ success: boolean; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    
    // Create empty file using touch command
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', `touch "${filePath}" && chmod 644 "${filePath}"`],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    
    const stream = await exec.start({ Tty: false });
    
    return new Promise((resolve) => {
      stream.on('end', async () => {
        try {
          const info = await exec.inspect();
          if (info.ExitCode !== 0) {
            resolve({ success: false, error: 'Failed to create file' });
            return;
          }
          Logger.success(`File created in container ${containerId}: ${filePath}`);
          resolve({ success: true });
        } catch (err) {
          resolve({ success: false, error: 'Failed to create file' });
        }
      });
      
      stream.on('error', () => {
        resolve({ success: false, error: 'Stream error' });
      });
    });
  } catch (err: any) {
    Logger.dockerError('Error creating file in container:', err);
    return { success: false, error: err.message };
  }
}

// Create a new folder in container
export async function createFolderInContainer(
  containerId: string,
  folderPath: string
): Promise<{ success: boolean; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    
    // Create folder with mkdir -p
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', `mkdir -p "${folderPath}" && chmod 755 "${folderPath}"`],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    
    const stream = await exec.start({ Tty: false });
    
    return new Promise((resolve) => {
      stream.on('end', async () => {
        try {
          const info = await exec.inspect();
          if (info.ExitCode !== 0) {
            resolve({ success: false, error: 'Failed to create folder' });
            return;
          }
          Logger.success(`Folder created in container ${containerId}: ${folderPath}`);
          resolve({ success: true });
        } catch (err) {
          resolve({ success: false, error: 'Failed to create folder' });
        }
      });
      
      stream.on('error', () => {
        resolve({ success: false, error: 'Stream error' });
      });
    });
  } catch (err: any) {
    Logger.dockerError('Error creating folder in container:', err);
    return { success: false, error: err.message };
  }
}

// Delete file or folder from container
export async function deleteFileOrFolderInContainer(
  containerId: string,
  path: string,
  isFolder: boolean = false
): Promise<{ success: boolean; error?: string }> {
  if (!docker) return { success: false, error: 'Docker daemon not available' };
  
  try {
    const container = docker.getContainer(containerId);
    
    // Use rm for files, rm -rf for folders
    const cmd = isFolder 
      ? `rm -rf "${path}"` 
      : `rm -f "${path}"`;
    
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', cmd],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    
    const stream = await exec.start({ Tty: false });
    
    return new Promise((resolve) => {
      stream.on('end', async () => {
        try {
          const info = await exec.inspect();
          if (info.ExitCode !== 0) {
            resolve({ success: false, error: `Failed to delete ${isFolder ? 'folder' : 'file'}` });
            return;
          }
          Logger.success(`${isFolder ? 'Folder' : 'File'} deleted from container ${containerId}: ${path}`);
          resolve({ success: true });
        } catch (err) {
          resolve({ success: false, error: `Failed to delete ${isFolder ? 'folder' : 'file'}` });
        }
      });
      
      stream.on('error', () => {
        resolve({ success: false, error: 'Stream error' });
      });
    });
  } catch (err: any) {
    Logger.dockerError(`Error deleting ${isFolder ? 'folder' : 'file'} from container:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Configuration management for Docker and other settings
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Logger } from './logger';

interface AppConfig {
  docker: {
    socketPath?: string;
    useDesktopSocket: boolean;
    detectedAt: string;
  };
}

const CONFIG_DIR = path.join(process.cwd(), '.nebula');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: AppConfig = {
  docker: {
    useDesktopSocket: false,
    detectedAt: '',
  },
};

/**
 * Initialize config directory and file if they don't exist
 */
async function initializeConfigDir(): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
  } catch (err) {
    Logger.warn('Could not create config directory:', err as Error);
  }
}

/**
 * Read configuration from file
 */
async function readConfig(): Promise<AppConfig> {
  try {
    await initializeConfigDir();
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data) as AppConfig;
  } catch (err) {
    // File doesn't exist or is invalid, return default
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Write configuration to file
 */
async function writeConfig(config: AppConfig): Promise<void> {
  try {
    await initializeConfigDir();
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    Logger.success(`Configuration saved to ${CONFIG_FILE}`);
  } catch (err) {
    Logger.error('Failed to write configuration:', err as Error);
  }
}

/**
 * Check if Docker Desktop socket exists and is accessible
 */
async function checkDockerDesktopSocket(): Promise<string | null> {
  const desktopSocketPath = path.join(os.homedir(), '.docker', 'desktop', 'docker.sock');
  
  try {
    // Check both existence and readability
    await fs.access(desktopSocketPath, fs.constants.R_OK | fs.constants.W_OK);
    Logger.success(`Docker Desktop socket found and accessible: ${desktopSocketPath}`);
    return desktopSocketPath;
  } catch (err) {
    Logger.debug(`Docker Desktop socket not accessible at ${desktopSocketPath}`);
    return null;
  }
}

/**
 * Check for Docker daemon socket (fallback)
 */
async function checkDockerDaemonSocket(): Promise<string | null> {
  const daemonSocketPath = '/var/run/docker.sock';
  
  try {
    // Check both existence and readability
    await fs.access(daemonSocketPath, fs.constants.R_OK | fs.constants.W_OK);
    Logger.success(`Docker daemon socket found and accessible: ${daemonSocketPath}`);
    return daemonSocketPath;
  } catch (err) {
    Logger.debug(`Docker daemon socket not accessible at ${daemonSocketPath}`);
    return null;
  }
}

/**
 * Detect available Docker sockets
 */
async function detectAvailableSockets(): Promise<{ desktop: string | null; daemon: string | null }> {
  const desktop = await checkDockerDesktopSocket();
  const daemon = await checkDockerDaemonSocket();
  
  return { desktop, daemon };
}

/**
 * Initialize Docker configuration on first run
 */
export async function initializeDockerConfig(): Promise<string | null> {
  const config = await readConfig();

  // If socket path is already configured, use it
  if (config.docker.socketPath) {
    Logger.docker(`Using configured Docker socket: ${config.docker.socketPath}`);
    return config.docker.socketPath;
  }

  // Detect available sockets
  Logger.info('Detecting available Docker sockets...');
  const { desktop, daemon } = await detectAvailableSockets();

  if (desktop) {
    // Docker Desktop is available
    Logger.success('Docker Desktop detected. Using Desktop socket.');
    config.docker.socketPath = desktop;
    config.docker.useDesktopSocket = true;
    config.docker.detectedAt = new Date().toISOString();
    await writeConfig(config);
    return desktop;
  }

  if (daemon) {
    // Regular Docker daemon is available
    Logger.success('Docker daemon socket detected. Using daemon socket.');
    config.docker.socketPath = daemon;
    config.docker.useDesktopSocket = false;
    config.docker.detectedAt = new Date().toISOString();
    await writeConfig(config);
    return daemon;
  }

  // No Docker socket found
  Logger.warn('No Docker socket detected. Docker may not be installed or running.');
  return null;
}

/**
 * Get current Docker socket configuration
 */
export async function getDockerSocketPath(): Promise<string | null> {
  const config = await readConfig();
  return config.docker.socketPath || null;
}

/**
 * Get full configuration
 */
export async function getConfig(): Promise<AppConfig> {
  return await readConfig();
}

/**
 * Update Docker socket configuration
 */
export async function updateDockerSocket(socketPath: string, useDesktop: boolean = false): Promise<void> {
  const config = await readConfig();
  config.docker.socketPath = socketPath;
  config.docker.useDesktopSocket = useDesktop;
  config.docker.detectedAt = new Date().toISOString();
  await writeConfig(config);
  Logger.success(`Docker socket updated to: ${socketPath}`);
}

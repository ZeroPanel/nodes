/**
 * System info and utility functions
 */

import os from 'node:os';
import { promises as fs } from 'node:fs';
import https from 'node:https';
import { Logger } from './logger';

let cachedLocation: string | null = null;

// Detect disk type (SSD, HDD, NVMe, etc.)
export async function getDiskType(): Promise<string> {
  try {
    const devices = await fs.readdir('/sys/block');
    
    for (const device of devices) {
      if (device.startsWith('sd') || device.startsWith('vd') || device.startsWith('hd')) {
        try {
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
export async function getRamType(): Promise<string> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    
    try {
      const { stdout } = await execFileAsync('dmidecode', ['-t', 'memory'], { timeout: 5000 });
      
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
export async function getLocation(): Promise<string> {
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
              const locationStr = `${city}, ${country} (${countryCode}-${region}-01)`;
              cachedLocation = locationStr;
              resolve(locationStr);
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

// Get system information
export async function getSystemInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  const cpus = os.cpus();
  const cpuCount = cpus.length;
  
  let totalIdle = 0;
  let totalTick = 0;
  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type as keyof typeof cpu.times];
    }
    totalIdle += cpu.times.idle;
  });
  const cpuUsage = 100 - Math.round((100 * totalIdle) / totalTick);
  
  let totalDisk = 0;
  let usedDisk = 0;
  try {
    const stats = await fs.statfs('/');
    totalDisk = stats.blocks * stats.bsize;
    usedDisk = (stats.blocks - stats.bavail) * stats.bsize;
  } catch (err) {
    Logger.error('Could not retrieve disk info:' + String(err));
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

// Generate a unique maintenance code
export function generateMaintenanceCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

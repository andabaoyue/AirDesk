const { execFileSync } = require('child_process');

const VIRTUAL_AUDIO_PRIORITY_RE = /cable input|vb-audio|vb-cable/i;
const VIRTUAL_AUDIO_FALLBACK_RE = /virtual audio|voicemeeter/i;

function createVirtualAudioManager({ resolveWinHelperExePath }) {
  let virtualAudioSavedDefaultId = null;
  let virtualAudioActiveDeviceId = null;
  let virtualAudioActiveDeviceName = '';

  function runWinHelperAudioCli(args) {
    if (process.platform !== 'win32') {
      return { ok: false, error: 'unsupported_platform' };
    }
    const exePath = resolveWinHelperExePath();
    if (!exePath) {
      return { ok: false, error: 'win_helper_unavailable' };
    }
    try {
      const out = execFileSync(exePath, args, {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 4000,
      });
      const lines = String(out || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      return lastLine ? JSON.parse(lastLine) : { ok: false, error: 'empty_output' };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'audio_cli_failed' };
    }
  }

  function pickBestVirtualAudioDevice(devices) {
    if (!Array.isArray(devices) || devices.length === 0) return null;
    const prio = devices.find((d) => VIRTUAL_AUDIO_PRIORITY_RE.test(String(d && d.name ? d.name : '')));
    if (prio) return prio;
    return devices.find((d) => VIRTUAL_AUDIO_FALLBACK_RE.test(String(d && d.name ? d.name : ''))) || null;
  }

  function queryVirtualAudioInfo() {
    if (process.platform !== 'win32') {
      return { supported: false, available: false, deviceId: '', deviceName: '', active: false, devices: [] };
    }
    const res = runWinHelperAudioCli(['--audio-list']);
    const devices = res && res.ok && Array.isArray(res.devices) ? res.devices : [];
    const best = pickBestVirtualAudioDevice(devices);
    return {
      supported: true,
      available: Boolean(best),
      deviceId: best ? String(best.id || '') : '',
      deviceName: best ? String(best.name || '') : '',
      active: Boolean(virtualAudioActiveDeviceId),
      devices,
    };
  }

  function restoreVirtualAudioOutput() {
    const savedId = virtualAudioSavedDefaultId;
    virtualAudioSavedDefaultId = null;
    virtualAudioActiveDeviceId = null;
    virtualAudioActiveDeviceName = '';
    if (!savedId || process.platform !== 'win32') {
      return { ok: true, restored: false };
    }
    try {
      const res = runWinHelperAudioCli(['--audio-set', savedId]);
      return { ok: Boolean(res && res.ok), restored: Boolean(res && res.ok), error: res && res.error };
    } catch {
      return { ok: false, restored: false };
    }
  }

  function setVirtualAudioRoute(enable, requestedDeviceId = '') {
    if (process.platform !== 'win32') {
      return { ok: false, active: false, switched: false, reason: '仅支持 Windows 系统' };
    }
    if (!enable) {
      const res = restoreVirtualAudioOutput();
      return { ok: Boolean(res.ok), active: false, switched: false, restored: Boolean(res.restored) };
    }
    if (virtualAudioActiveDeviceId) {
      return {
        ok: true,
        active: true,
        switched: false,
        deviceId: virtualAudioActiveDeviceId,
        deviceName: virtualAudioActiveDeviceName,
      };
    }
    const listRes = runWinHelperAudioCli(['--audio-list']);
    if (!listRes || !listRes.ok) {
      return {
        ok: false,
        active: false,
        switched: false,
        reason: (listRes && listRes.error) || '枚举音频设备失败',
      };
    }
    const devices = Array.isArray(listRes.devices) ? listRes.devices : [];
    const target =
      (requestedDeviceId && devices.find((d) => String(d.id) === String(requestedDeviceId))) ||
      pickBestVirtualAudioDevice(devices);
    if (!target || !target.id) {
      return {
        ok: false,
        active: false,
        switched: false,
        reason: '未检测到 VB-Cable 等虚拟音频输出设备',
      };
    }
    const currentDefaultId = String(listRes.defaultId || '');
    if (currentDefaultId && currentDefaultId === String(target.id)) {
      virtualAudioSavedDefaultId = null;
      virtualAudioActiveDeviceId = String(target.id);
      virtualAudioActiveDeviceName = String(target.name || '');
      return {
        ok: true,
        active: true,
        switched: false,
        deviceId: virtualAudioActiveDeviceId,
        deviceName: virtualAudioActiveDeviceName,
      };
    }
    const setRes = runWinHelperAudioCli(['--audio-set', String(target.id)]);
    if (!setRes || !setRes.ok) {
      return {
        ok: false,
        active: false,
        switched: false,
        reason: (setRes && setRes.error) || '切换默认音频设备失败',
      };
    }
    virtualAudioSavedDefaultId = currentDefaultId || null;
    virtualAudioActiveDeviceId = String(target.id);
    virtualAudioActiveDeviceName = String(target.name || '');
    return {
      ok: true,
      active: true,
      switched: true,
      deviceId: virtualAudioActiveDeviceId,
      deviceName: virtualAudioActiveDeviceName,
    };
  }

  return {
    queryVirtualAudioInfo,
    setVirtualAudioRoute,
    restoreVirtualAudioOutput,
  };
}

module.exports = {
  createVirtualAudioManager,
};

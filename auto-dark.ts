#!/usr/bin/env -S deno --allow-env --allow-read --allow-run --allow-net

// #region imports, types
import { load } from '@std/dotenv';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { Console } from 'node:console';
import { join } from 'node:path';
import { argv, env, exit, stderr, stdin, stdout } from 'node:process';

interface DarkLightSetting {
  /** setting to apply when dark */
  dark: string;
  /** setting to apply when light */
  light: string;
}
interface GtkSettings {
  /** from `gsettings get org.gnome.desktop.interface color-scheme` */
  'color-scheme': DarkLightSetting;
  /** from `gsettings get org.gnome.desktop.interface gtk-theme` */
  'gtk-theme': DarkLightSetting;
  /** from `gsettings get org.gnome.desktop.interface icon-theme` */
  'icon-theme': DarkLightSetting;
}
interface KdeSettings {
  /** from `plasma-apply-colorscheme -l` */
  'color-scheme': DarkLightSetting;
  /** from `plasma-apply-lookandfeel -l` */
  'global-theme': DarkLightSetting;
}
interface HassSettings {
  /** e.g. `http://hass.local:8123/`, `https://hass.local/` */
  baseUrl: string;
  /** long-lived access token */
  token: string;
  /** seconds which sensor values must be stable for to be considered valid */
  debounceSeconds: number;
  /** hass binary sensor entity ids */
  sensors: {
    /** binary sensor which is `on` when dark */
    dark: `binary_sensor.${string}`;
    /** binary sensor which is `on` when light */
    light: `binary_sensor.${string}`;
  };
}
interface ScriptSettings {
  /** wakeup frequency during waits to check for elapsed time - necessary to detect system resume from sleep */
  pollSeconds: number;
  /** how frequently to check home assistant sensor state */
  checkSeconds: number;
  /** retry seconds if error during getting sensors or setting theme */
  retrySeconds: number;
  /** which theme manager to use */
  managerMode: 'gtk' | 'kde';
  /** which sensor source to use */
  sensorMode: 'hass';
  /** whether to enable the tui. may cause problems if enabled while running as a login script. can be overridden with `-tui` and `-no-tui` */
  tui: boolean;
}

// deno-lint-ignore ban-types
type KeyboardKey = string & {};

// deno-lint-ignore no-non-null-assertion
await load({ envPath: join(import.meta.dirname!, '.env'), export: true });

function envOrThrow(name: string): string {
  if (typeof env[name] === 'string') return env[name];
  throw new Error(`Undefined env var: ${name}`);
}
// #endregion

// #region constants
const GTK_SETTINGS: GtkSettings = {
  'color-scheme': { dark: 'prefer-dark', light: 'default' },
  'gtk-theme': { dark: 'Yaru-purple-dark', light: 'Yaru-purple' },
  'icon-theme': { dark: 'Yaru-purple-dark', light: 'Yaru-purple' },
};

const KDE_SETTINGS: KdeSettings = {
  'global-theme': { dark: 'org.kde.breezedark.desktop', light: 'org.kde.breeze.desktop' },
  'color-scheme': { dark: 'Breeze Lavendar Dark', light: 'Breeze Lavendar Light' },
};

const HASS_SETTINGS: HassSettings = {
  baseUrl: envOrThrow('HASS_URL'),
  token: envOrThrow('HASS_TOKEN'),
  debounceSeconds: 900,
  sensors: {
    dark: 'binary_sensor.lamp_light_level_on',
    light: 'binary_sensor.lamp_light_level_off',
  },
};

const SCRIPT_SETTINGS: ScriptSettings = {
  pollSeconds: 1,
  checkSeconds: 60,
  retrySeconds: 3,
  managerMode: 'kde',
  sensorMode: 'hass',
  tui: false,
};
// #endregion

// #region logger
enum LogLevel {
  TRACE,
  DEBUG,
  INFO,
  WARN,
  ERROR,
}

class Logger {
  constructor(
    private readonly root: RootLogger,
    private readonly name: string,
  ) {}

  #prefix(colour: number, levelName: string) {
    const now = new Date();
    return `[\x1b[1;${colour}m${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${
      now.getDate().toString().padStart(2, '0')
    } ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${
      now.getSeconds().toString().padStart(2, '0')
    } ${levelName}:${this.name}\x1b[0m]`;
  }

  trace(...args: unknown[]) {
    if (this.root.level <= LogLevel.TRACE) this.root.console.debug(this.#prefix(36, 'Trace'), ...args);
  }
  debug(...args: unknown[]) {
    if (this.root.level <= LogLevel.DEBUG) this.root.console.debug(this.#prefix(34, 'Debug'), ...args);
  }
  info(...args: unknown[]) {
    if (this.root.level <= LogLevel.INFO) this.root.console.info(this.#prefix(32, 'Info'), ...args);
  }
  warn(...args: unknown[]) {
    if (this.root.level <= LogLevel.WARN) this.root.console.warn(this.#prefix(33, 'Warn'), ...args);
  }
  error(...args: unknown[]) {
    if (this.root.level <= LogLevel.ERROR) this.root.console.error(this.#prefix(31, 'Error'), ...args);
  }
}

class RootLogger {
  public readonly console = new Console({
    stdout,
    stderr,
    colorMode: true,
    groupIndentation: 2,
    ignoreErrors: true,
    inspectOptions: { breakLength: 160 },
  });

  constructor(public level: LogLevel = LogLevel.INFO) {}

  make(name: string): Logger {
    return new Logger(this, name);
  }
}

const rootLogger = new RootLogger();
// #endregion

// #region manager
abstract class Manager<Settings> {
  protected logger = rootLogger.make(this.constructor.name);
  constructor(protected readonly settings: Settings) {}
  abstract setDark(value: boolean): boolean;
  abstract isDark(): boolean | null;
}

class GtkManager extends Manager<GtkSettings> {
  #gSettings(method: 'set' | 'get', ...args: string[]): { stdout: string; status: number | null } {
    const gSettingsArgs = [method, 'org.gnome.desktop.interface', ...args];
    const result = spawnSync('gsettings', gSettingsArgs);
    const stdout = result.stdout.toString().trim().replaceAll("'", '');
    const { status } = result;
    this.logger.trace('spawnSync', ['gsettings', ...gSettingsArgs], { stdout, status });
    return { stdout, status };
  }

  override setDark(value: boolean): boolean {
    return Object.entries(this.settings)
      .map(([key, config]) => this.#gSettings('set', key, value ? config.dark : config.light).status)
      .reduce((acc, item) => acc && item === 0, true);
  }

  override isDark(): boolean | null {
    const result = Object.entries(this.settings)
      .map(([key, config]) => ({ key, ...config, value: this.#gSettings('get', key).stdout }))
      .map((item) => (item.value === item.dark ? true : item.value === item.light ? false : null))
      .reduce((acc, item) => (acc === item ? acc : null));
    this.logger.debug('isDark', { result });
    return result;
  }
}

class KdeManager extends Manager<KdeSettings> {
  override setDark(value: boolean): boolean {
    try {
      const args = [this.settings['color-scheme'][value ? 'dark' : 'light']];
      const result = spawnSync('plasma-apply-colorscheme', args);
      const stdout = result.stdout.toString().trim();
      const { status } = result;
      this.logger.trace('spawnSync', ['plasma-apply-colorscheme', ...args], { stdout, status });
      return status === 0;
    } catch (err) {
      this.logger.error('spawnSync', err);
      return false;
    }
  }

  override isDark(): boolean | null {
    try {
      const args = ['--file', 'kdeglobals', '--group', 'General', '--key', 'ColorScheme'];
      const result = spawnSync('kreadconfig6', args);
      const stdout = result.stdout.toString().trim();
      const { status } = result;
      this.logger.trace('spawnSync', ['kreadconfig6', ...args], { stdout, status });
      if (stdout === this.settings['color-scheme'].dark) return true;
      if (stdout === this.settings['color-scheme'].light) return false;
    } catch (err) {
      this.logger.error('isDark', err);
    }
    return null;
  }
}
// #endregion

// #region sensors
abstract class Sensors<Settings> {
  protected logger = rootLogger.make(this.constructor.name);
  constructor(protected readonly settings: Settings) {}
  abstract isDark(): Promise<boolean | null>;
}

class HassSensors extends Sensors<HassSettings> {
  #logger = rootLogger.make(this.constructor.name);

  async #read(sensorName: string): Promise<boolean> {
    const response = await fetch(new URL(join('api/states', sensorName), this.settings.baseUrl), {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.settings.token}` },
    });
    const { state, last_changed: lastChanged }: { state: string; last_changed: string } = await response.json();
    const ageSeconds = (Date.now() - new Date(lastChanged).getTime()) / 1000;
    const result = state === 'on' && ageSeconds >= this.settings.debounceSeconds;
    this.#logger.trace('read', { sensorName, state, ageSeconds, result });
    return result;
  }

  override async isDark(): Promise<boolean | null> {
    const result = (await this.#read(this.settings.sensors.light))
      ? false
      : (await this.#read(this.settings.sensors.dark)) || null;
    this.#logger.debug('isDark', { result });
    return result;
  }
}
// #endregion

// #region utils
// there is no trivial way to get an event on system resume. so polling :|
class Waiter {
  constructor(private readonly pollSeconds: number) {}
  async wait(seconds: number): Promise<void> {
    const until = new Date();
    until.setSeconds(until.getSeconds() + seconds);
    return await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (new Date() < until) return;
        clearInterval(interval);
        resolve();
      }, this.pollSeconds);
    });
  }
}

class Tui {
  #logger = rootLogger.make('Tui');

  constructor(private readonly commands: Record<KeyboardKey, [label: string, callback: () => unknown]>) {
    stdin.setRawMode(true);
    stdin.addListener('data', (data) => this.#handleKeyPress(data));
  }

  #handleKeyPress(data: string | Buffer) {
    const key = data.toString();
    const command = this.commands[key];
    if (command) {
      this.#logger.info(command[0]);
      try {
        command[1]();
      } catch (error) {
        this.#logger.error(error);
      }
    } else if (['?', 'h'].includes(key))
      Object.entries(this.commands).forEach(([key, value]) => this.#logger.info({ key }, value[0]));
    else this.#logger.warn('unhandled', { key });
  }

  stop(): void {
    stdin.removeAllListeners();
    stdin.setRawMode(false);
  }
}
// #endregion

async function main() {
  const logger = rootLogger.make('main');

  const manager = SCRIPT_SETTINGS.managerMode === 'kde'
    ? new KdeManager(KDE_SETTINGS)
    : SCRIPT_SETTINGS.managerMode === 'gtk'
    ? new GtkManager(GTK_SETTINGS)
    : null;
  if (manager === null) throw new Error(`Unhandled managerMode: ${SCRIPT_SETTINGS.managerMode}`);

  const sensors = SCRIPT_SETTINGS.sensorMode === 'hass' ? new HassSensors(HASS_SETTINGS) : null;
  if (sensors === null) throw new Error(`Unhandled sensorMode: ${SCRIPT_SETTINGS.sensorMode}`);

  const waiter = new Waiter(SCRIPT_SETTINGS.pollSeconds);

  for (const arg of argv.slice(2)) {
    if (arg === '-no-tui') SCRIPT_SETTINGS.tui = false;
    else if (arg === '-tui') SCRIPT_SETTINGS.tui = true;
    else throw new Error(`Unhandled arg: ${arg}`);
  }

  if (SCRIPT_SETTINGS.tui) {
    new Tui({
      a: [
        'manager.set(auto)',
        () =>
          sensors.isDark().then((
            dark,
          ) => (dark === null ? logger.warn('sensors.isDark', dark) : manager.setDark(dark))),
      ],
      d: ['manager.setDark(true)', () => manager.setDark(true)],
      l: ['manager.setDark(false)', () => manager.setDark(false)],
      s: ['sensors.isDark', () => sensors.isDark().then((dark) => logger.info('sensors.isDark', dark))],
      '1': ['rootLogger.level=LogLevel.TRACE', () => rootLogger.level = LogLevel.TRACE],
      '2': ['rootLogger.level=LogLevel.DEBUG', () => rootLogger.level = LogLevel.DEBUG],
      '3': ['rootLogger.level=LogLevel.INFO', () => rootLogger.level = LogLevel.INFO],
      '4': ['rootLogger.level=LogLevel.WARN', () => rootLogger.level = LogLevel.WARN],
      '5': ['rootLogger.level=LogLevel.ERROR', () => rootLogger.level = LogLevel.ERROR],
      q: ['exit', () => exit(0)],
      '\x03': ['exit', () => exit(0)],
    });
  }

  let settingsDark = manager.isDark();
  let initial = true;
  while (true) {
    try {
      const sensorsDark = await sensors.isDark();
      if (sensorsDark !== null && settingsDark !== sensorsDark) {
        const result = manager.setDark(sensorsDark);
        logger.info({ settingsDark, sensorsDark, result });
        if (result) settingsDark = sensorsDark;
      } else if (initial) { logger.info({ settingsDark, sensorsDark }); }
      if (initial) initial = false;
      await waiter.wait(SCRIPT_SETTINGS.checkSeconds);
    } catch (error) {
      logger.error(String(error));
      await waiter.wait(SCRIPT_SETTINGS.retrySeconds);
    }
  }
}

await main();

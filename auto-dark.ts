#!/usr/bin/env -S deno --allow-env --allow-read --allow-run --allow-net

import '@std/dotenv/load';
import {Buffer} from 'node:buffer';
import {spawnSync} from 'node:child_process';
import {Console} from 'node:console';
import {join} from 'node:path';
import {argv, env, exit, stderr, stdin, stdout} from 'node:process';

type GtkSettings = Record<'color-scheme' | 'gtk-theme' | 'icon-theme', { dark: string; light: string }>;
type KdeSettings = Record<'global-theme' | 'color-scheme', { dark: string; light: string }>;
interface HassSettings {
  baseUrl: string;
  token: string;
  lightSensor: string;
  darkSensor: string;
  debounceSeconds: number;
}

// #region constants
const HASS_URL = env.HASS_URL;
const HASS_TOKEN = env.HASS_TOKEN;

const DARK_SENSOR = 'binary_sensor.lamp_light_level_on';
const LIGHT_SENSOR = 'binary_sensor.lamp_light_level_off';

/** wakeup frequency during waits to check for elapsed time - necessary to detect system resume from sleep */
const POLL_SECONDS = 1;
/** sensor check seconds */
const CHECK_SECONDS = 60;
/** retry seconds if error during getting sensors or setting theme */
const RETRY_SECONDS = 3;
/** seconds which sensor values must be stable for to be considered valid */
const DEBOUNCE_SECONDS = 900;

const GTK_SETTINGS: GtkSettings = {
  /** from `gsettings get org.gnome.desktop.interface color-scheme` */
  'color-scheme': { dark: 'prefer-dark', light: 'default' },
  /** from `gsettings get org.gnome.desktop.interface gtk-theme` */
  'gtk-theme': { dark: 'Yaru-purple-dark', light: 'Yaru-purple' },
  /** from `gsettings get org.gnome.desktop.interface icon-theme` */
  'icon-theme': { dark: 'Yaru-purple-dark', light: 'Yaru-purple' },
};

const KDE_SETTINGS: KdeSettings = {
  /** from `plasma-apply-lookandfeel -l` */
  'global-theme': { dark: 'org.kde.breezedark.desktop', light: 'org.kde.breeze.desktop' },
  /** from `plasma-apply-colorscheme -l` */
  'color-scheme': { dark: 'Breeze Purple', light: 'BreezeLight' },
};

const MODE: 'gtk' | 'kde' = 'kde';
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
    const result = (await this.#read(this.settings.lightSensor))
      ? false
      : (await this.#read(this.settings.darkSensor)) || null;
    this.#logger.debug('isDark', { result });
    return result;
  }
}
// #endregion

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

// deno-lint-ignore ban-types
type KeyboardKey = string & {};

class Tui {
  #logger = rootLogger.make('Tui');

  constructor(private readonly commands: Record<KeyboardKey, { label: string; callback: () => unknown }>) {
    stdin.setRawMode(true);
    stdin.addListener('data', (data) => this.#handleKeyPress(data));
  }

  #handleKeyPress(data: string | Buffer) {
    const key = data.toString();
    const command = this.commands[key];
    if (command) {
      this.#logger.info(command.label);
      try {
        command.callback();
      } catch (error) {
        this.#logger.error(error);
      }
    } else if (['?', 'h'].includes(key))
      Object.entries(this.commands).forEach(([key, value]) => this.#logger.info({ key }, value.label));
    else this.#logger.warn('unhandled', { key });
  }

  stop(): void {
    stdin.removeAllListeners();
    stdin.setRawMode(false);
  }
}

async function main() {
  if (typeof HASS_URL !== 'string') throw new Error('HASS_URL env var is not defined');
  if (typeof HASS_TOKEN !== 'string') throw new Error('HASS_TOKEN env var is not defined');

  const logger = rootLogger.make('main');

  const manager = MODE === 'kde' ? new KdeManager(KDE_SETTINGS) : MODE === 'gtk' ? new GtkManager(GTK_SETTINGS) : null;
  if (manager === null) throw new Error('unhandled MODE');

  const sensors = new HassSensors({
    baseUrl: HASS_URL,
    token: HASS_TOKEN,
    darkSensor: DARK_SENSOR,
    lightSensor: LIGHT_SENSOR,
    debounceSeconds: DEBOUNCE_SECONDS,
  });

  const waiter = new Waiter(POLL_SECONDS);

  const options = { tui: false };

  for (const arg of argv.slice(2)) {
    if (arg === '-no-tui') options.tui = false;
    else if (arg === '-tui') options.tui = true;
    else throw new Error(`unknown arg ${arg}`);
  }

  if (options.tui) {
    new Tui({
      a: {
        label: 'manager.set(auto)',
        callback: () =>
          sensors.isDark().then((
            dark,
          ) => (dark === null ? logger.warn('sensors.isDark', dark) : manager.setDark(dark))),
      },
      d: { label: 'manager.setDark(true)', callback: () => manager.setDark(true) },
      l: { label: 'manager.setDark(false)', callback: () => manager.setDark(false) },
      s: {
        label: 'sensors.isDark',
        callback: () => sensors.isDark().then((dark) => logger.info('sensors.isDark', dark)),
      },
      '1': { label: 'rootLogger.level=LogLevel.TRACE', callback: () => rootLogger.level = LogLevel.TRACE },
      '2': { label: 'rootLogger.level=LogLevel.DEBUG', callback: () => rootLogger.level = LogLevel.DEBUG },
      '3': { label: 'rootLogger.level=LogLevel.INFO', callback: () => rootLogger.level = LogLevel.INFO },
      '4': { label: 'rootLogger.level=LogLevel.WARN', callback: () => rootLogger.level = LogLevel.WARN },
      '5': { label: 'rootLogger.level=LogLevel.ERROR', callback: () => rootLogger.level = LogLevel.ERROR },
      q: { label: 'exit', callback: () => exit(0) },
      '\x03': { label: 'exit', callback: () => exit(0) },
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
      await waiter.wait(CHECK_SECONDS);
    } catch (error) {
      logger.error(String(error));
      await waiter.wait(RETRY_SECONDS);
    }
  }
}

await main();

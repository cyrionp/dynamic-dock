// Every item type that can go on a bar, by its catalog id.

import { apps, launcher } from "./apps.js";
import * as buttons from "./buttons.js";
import { clock, weather } from "./clock.js";
import { media, volume } from "./media.js";
import { stats, network, battery, recycle, power, tray } from "./system.js";
import { stopwatch, countdown, notesWidget, todo } from "./productivity.js";
import { fps } from "./fps.js";

export const WIDGETS = {
  apps,
  launcher,
  start: buttons.start,
  search: buttons.search,
  taskview: buttons.taskview,
  widgetsWin: buttons.widgetsWin,
  notifications: buttons.notifications,
  quicksettings: buttons.quicksettings,
  clipboard: buttons.clipboard,
  snip: buttons.snip,
  explorer: buttons.explorer,
  settingsWin: buttons.settingsWin,
  run: buttons.run,
  desktop: buttons.desktop,
  dockSettings: buttons.dockSettings,
  separator: buttons.separator,
  spacer: buttons.spacer,
  barSwitcher: buttons.barSwitcher,
  tray,
  clock,
  weather,
  media,
  volume,
  stats,
  network,
  battery,
  recycle,
  power,
  fps,
  stopwatch,
  countdown,
  notes: notesWidget,
  todo,
};

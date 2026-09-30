'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

const ICON_DIR = path.join(__dirname, '..', 'renderer', 'assets');

function createTray({ windows, settings, controller, agent }) {
  const image = nativeImage.createFromPath(path.join(ICON_DIR, 'tray.png'));
  const hiDpi = nativeImage.createFromPath(path.join(ICON_DIR, 'tray@2x.png'));
  if (!hiDpi.isEmpty()) image.addRepresentation({ scaleFactor: 2, buffer: hiDpi.toPNG() });
  const tray = new Tray(image);
  tray.setToolTip(`${settings.get('assistantName')} · Ready`);
  tray.on('click', () => windows.openMain('home'));
  tray.on('right-click', () => {
    const name = settings.get('assistantName');
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: `Open ${name}`, click: () => windows.showPanel() },
      { label: 'Select an Area to Ask About', click: () => controller.startPanelSelection() },
      { type: 'separator' },
      { label: 'Settings…', click: () => windows.openSettings() },
      { label: 'Bigfoot Terminal', click: () => windows.openTerminal() },
      { type: 'separator' },
      { label: `Show ${name} Next to Cursor`, type: 'checkbox', checked: settings.get('showBuddy'), click: (item) => settings.update({ showBuddy: item.checked }) },
      { label: `Answer to “Hey ${name}”`, type: 'checkbox', checked: settings.get('wakeWord'), click: (item) => settings.update({ wakeWord: item.checked }) },
      { label: 'Speak Replies', type: 'checkbox', checked: settings.get('speakResponses'), click: (item) => settings.update({ speakResponses: item.checked }) },
      { label: 'New Conversation', enabled: !agent.running, click: () => agent.reset() },
      { type: 'separator' },
      { label: `Quit ${name}`, click: () => app.quit() },
    ]));
  });
  windows.tray = tray;
  return tray;
}

module.exports = { createTray };

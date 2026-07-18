const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class MemoryStorage {
    constructor({ noOp = false } = {}) { this.values = new Map(); this.noOp = noOp; }
    getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
    setItem(key, value) { if (!this.noOp) this.values.set(String(key), String(value)); }
    removeItem(key) { this.values.delete(String(key)); }
}

function loadPluginClass(storage = new MemoryStorage(), globals = {}) {
    const filename = path.join(__dirname, 'plugin.js');
    const source = fs.readFileSync(filename, 'utf8') + '\nglobalThis.__PluginManager = Plugin;';
    const context = vm.createContext({
        AppPlugin: class {},
        clearInterval: globals.clearInterval || clearInterval,
        clearTimeout: globals.clearTimeout || clearTimeout,
        console: { log: console.log, error: console.error, warn() {} },
        document: globals.document,
        localStorage: storage,
        setInterval: globals.setInterval || setInterval,
        setTimeout: globals.setTimeout || setTimeout,
    });
    vm.runInContext(source, context, { filename });
    return { PluginManager: context.__PluginManager, storage };
}

function fakeNode() {
    return {
        children: [],
        style: {},
        _text: '',
        appendChild(child) { this.children.push(child); return child; },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        get textContent() { return this._text; },
        set textContent(value) { this._text = String(value); },
    };
}

test('disable snapshots live custom settings and verifies the backup before trashing', async () => {
    const { PluginManager, storage } = loadPluginClass();
    const manager = Object.create(PluginManager.prototype);
    manager._disabledPlugins = {};
    let trashed = false;
    const plugin = {
        getGuid: () => 'guid-1',
        getExistingCodeAndConfig: () => ({ json: { name: 'Example', type: 'app', custom: { settings: { value: 7 } } } }),
        trashPlugin: async () => { trashed = true; return true; },
    };

    await manager._disablePluginCore(plugin, { name: 'Stale', custom: { settings: { value: 1 } } });

    assert.equal(trashed, true);
    const backup = JSON.parse(storage.getItem('pm_disabled_plugins'));
    assert.deepEqual(backup['local:guid-1'].custom, { settings: { value: 7 } });
});

test('disable refuses to trash when storage silently drops the settings backup', async () => {
    const { PluginManager } = loadPluginClass(new MemoryStorage({ noOp: true }));
    const manager = Object.create(PluginManager.prototype);
    manager._disabledPlugins = {};
    let trashed = false;
    const plugin = {
        getGuid: () => 'guid-2',
        getExistingCodeAndConfig: () => ({ json: { name: 'Example', type: 'app', custom: { value: 9 } } }),
        trashPlugin: async () => { trashed = true; return true; },
    };

    await assert.rejects(() => manager._disablePluginCore(plugin, plugin.getExistingCodeAndConfig().json), /verify/i);
    assert.equal(trashed, false);
});

test('enable removes the backup only after restored custom settings read back exactly', async () => {
    const { PluginManager, storage } = loadPluginClass();
    const manager = Object.create(PluginManager.prototype);
    const disabled = {
        key: 'local:guid-3',
        guid: 'guid-3',
        name: 'Example',
        type: 'app',
        sourceRepo: null,
        custom: { settings: { second: 2, first: 1 } },
        json: { name: 'Example', type: 'app' },
        code: 'class Plugin extends AppPlugin {}',
        css: '',
    };
    manager._disabledPlugins = { [disabled.key]: disabled };
    manager._saveDisabledPlugins();
    manager.installPlugin = async (json) => ({
        getExistingCodeAndConfig: () => ({ json: { ...json, custom: { settings: { first: 1, second: 2 } } } }),
    });

    assert.equal(await manager._enableDisabledPluginCore(disabled), 'Example');
    assert.deepEqual(JSON.parse(storage.getItem('pm_disabled_plugins')), {});
});

test('enable keeps the backup when restored settings cannot be verified', async () => {
    const { PluginManager, storage } = loadPluginClass();
    const manager = Object.create(PluginManager.prototype);
    const disabled = {
        key: 'local:guid-4',
        guid: 'guid-4',
        name: 'Example',
        type: 'app',
        sourceRepo: null,
        custom: { settings: { value: 4 } },
        json: { name: 'Example', type: 'app' },
        code: '',
        css: '',
    };
    manager._disabledPlugins = { [disabled.key]: disabled };
    manager._saveDisabledPlugins();
    manager.installPlugin = async (json) => ({
        getExistingCodeAndConfig: () => ({ json: { ...json, custom: { settings: { value: 0 } } } }),
    });

    await assert.rejects(() => manager._enableDisabledPluginCore(disabled), /could not be verified/i);
    assert.ok(JSON.parse(storage.getItem('pm_disabled_plugins'))[disabled.key]);
});

test('manager preferences keep a retry journal until config save is confirmed', async () => {
    const { PluginManager, storage } = loadPluginClass();
    const manager = Object.create(PluginManager.prototype);
    let conf = { name: 'Plugins Manager', custom: { community_repos: 'old', saved_themes: [] } };
    let accept = false;
    manager.getGuid = () => 'manager-guid';
    manager.getConfiguration = () => JSON.parse(JSON.stringify(conf));
    manager.data = {
        getPluginByGuid: () => ({
            saveConfiguration: async (next) => {
                if (!accept) return false;
                conf = JSON.parse(JSON.stringify(next));
                return true;
            },
        }),
    };
    manager.ui = { addToaster() {} };
    manager._savedThemes = [];
    manager._autoExportEnabled = false;

    assert.equal(await manager._saveManagerSettings({ communityRepos: 'new', savedThemes: [{ name: 'Dark' }] }), false);
    assert.deepEqual(JSON.parse(storage.getItem('pm_manager_settings_recovery')), {
        community_repos: 'new',
        saved_themes: [{ name: 'Dark' }],
    });

    accept = true;
    assert.equal(await manager._saveManagerSettings(), true);
    assert.equal(conf.custom.community_repos, 'new');
    assert.deepEqual(conf.custom.saved_themes, [{ name: 'Dark' }]);
    assert.equal(storage.getItem('pm_manager_settings_recovery'), null);
});

test('progress tally fills exactly when its matching row becomes opaque', () => {
    const document = {
        createDocumentFragment: fakeNode,
        createElement: fakeNode,
    };
    const { PluginManager } = loadPluginClass(new MemoryStorage(), { document });
    const manager = Object.create(PluginManager.prototype);
    manager._statusNode = fakeNode();
    manager._titleNode = fakeNode();
    manager._status = {
        title: 'Checking',
        total: 2,
        done: 1,
        final: false,
        verb: 'Checking',
        verbDone: 'Checked',
        finalTitle: '',
        items: [
            { name: 'First', state: 'done', version: '1.0.0' },
            { name: 'Second', state: 'pending', version: '1.0.0' },
        ],
    };

    manager._renderStatus();
    let body = manager._statusNode.children[0];
    assert.equal(body.children[0].textContent, '▰▱');
    assert.equal(body.children[1].style.opacity, undefined);
    assert.equal(body.children[2].style.opacity, '0.55');

    manager._status.items[1].state = 'active';
    manager._renderStatus();
    body = manager._statusNode.children[0];
    assert.equal(body.children[0].textContent, '▰▰');
    assert.equal(body.children[2].style.opacity, undefined);
});

test('final status auto-dismisses after five idle seconds and keeps the requested title', () => {
    let timeoutMs = null;
    let timeoutCallback = null;
    let destroyed = false;
    const document = {
        createDocumentFragment: fakeNode,
        createElement: fakeNode,
    };
    const { PluginManager } = loadPluginClass(new MemoryStorage(), {
        document,
        setTimeout(callback, ms) { timeoutCallback = callback; timeoutMs = ms; return 17; },
        clearTimeout() {},
    });
    const manager = Object.create(PluginManager.prototype);
    manager._statusNode = fakeNode();
    manager._titleNode = fakeNode();
    manager._progressToast = { destroy() { destroyed = true; } };
    manager._status = {
        title: 'Checking', total: 0, done: 0, items: [], final: true,
        verb: '', verbDone: '', finalTitle: 'Everything up to date!',
    };

    manager._renderStatus();
    assert.equal(manager._titleNode.textContent, 'Everything up to date!');
    manager._scheduleStatusAutoDismiss();
    assert.equal(timeoutMs, 5000);
    timeoutCallback();
    assert.equal(destroyed, true);
    assert.equal(manager._progressToast, null);
});

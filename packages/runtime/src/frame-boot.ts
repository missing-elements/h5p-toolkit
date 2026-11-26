/**
 * Runs in the frame: boots the core, forwards xAPI and relays job requests to the element. GPL with
 * the core, not in the MIT player; its config block and messages are the player's contract.
 */

import { checkContent, checkContentMetadata, libraryKey, librariesIn, parseLibrary, type LibraryName, type SemanticField } from './content-check'
import { upgradeContent, type ServedLibrary, type UpgradeSource, type UpgradeTable } from './content-upgrade'
import { isResult } from './finished'
import { coreTranslations } from './l10n'
// The core's own English strings, from `getLocalization()` at the vendored commit: the defaults a
// language's strings are laid over, and what a frame in English shows.
import ENGLISH from '../vendor/h5p-core/strings.json'

/** How long a read of one of the package's JSON files may take before it counts as failed. */
var LIBRARY_READ_TIMEOUT_MS = 20000;

/** A fetch that gives up after `LIBRARY_READ_TIMEOUT_MS`, where the browser can be told to. */
var boundedFetch = function (url: string): Promise<Response> {
  var signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(LIBRARY_READ_TIMEOUT_MS) : undefined;
  return fetch(url, { signal: signal });
};

/** An error's message, or the thing thrown when it is not an error. */
var errorText = function (error: unknown): string {
  return String((error && (error as Error).message) || error);
};

/** The one content this frame registers with the runtime, once it has. */
var registeredContent = function () {
  var contents = window.H5PIntegration && window.H5PIntegration.contents;
  var key = contents ? Object.keys(contents)[0] : undefined;
  return contents && key ? contents[key] : undefined;
};

interface BootConfig {
  pkgId: string
  /** The package's root on the virtual file server, without a trailing slash. */
  h5pJsonPath: string
  /**
   * The worker's `boot` route, which answers what to load (`LibraryLoad`); absent from a worker of
   * a player pairing with runtime 0.2, which wrote the old loader's document.
   */
  boot?: string
  frameJs: string
  frameCss: string
  /** `h5p.json`'s title, and its licence, authors and the rest, in the shape `H5P.buildMetadataCopyrights` reads. */
  title?: string
  metadata?: Record<string, unknown>
  /** What the host asked for; the same shape as `FrameOptions` in shared/protocol.ts. */
  options?: FrameOptions
  /**
   * The frame's language, which H5P's own strings follow, when the worker named `l10n.js`: the
   * content's, as `h5p.json` names it, or the element's. The same tag as the document's `lang`.
   */
  language?: string
  /**
   * Played as data: the package's own code is withheld and this script checks its content against
   * the served semantics first. Absent from a worker older than the check.
   */
  untrusted?: boolean
}

/**
 * The header content is asked for with when it is to be checked: the worker serves an untrusted
 * `content.json` only with it, so a boot script older than the check gets none.
 */
var CONTENT_CHECK_HEADER = 'X-H5P-Content-Check';

/** What the worker's `boot` route answers: `LibraryLoad` in the player's `shared/protocol.ts`. */
interface LibraryLoad {
  library: string
  scripts: string[]
  styles: string[]
  directories: Record<string, string>
  upgrades: string[]
}

/** The one content in `H5PIntegration.contents`, as far as this script touches it. */
interface IntegrationContent {
  library: string
  jsonContent: string
  metadata?: unknown
  /** The content's folder, `<virtual root>/content`. */
  contentUrl?: string
}

/** The core's settings, `H5PIntegration`, in the shape a site's H5P plugin writes them. */
interface Integration {
  baseUrl: string
  url: string
  urlLibraries: string
  libraryDirectories: Record<string, string>
  contents: Record<string, IntegrationContent & Record<string, unknown>>
  saveFreq: number | false
  postUserStatistics: boolean
  reportingIsEnabled: boolean
  ajax: Record<string, string>
  l10n: { H5P: Record<string, string> }
  core: { scripts: string[]; styles: string[] }
  user?: { name: string; mail: string }
}

interface FrameOptions {
  frame?: boolean
  copyright?: boolean
  export?: boolean
  icon?: boolean
  embed?: boolean
  fullScreen?: boolean
  downloadUrl?: string
  embedCode?: string
  resizeCode?: string
  customCss?: string[]
  customJs?: string[]
  reportingIsEnabled?: boolean
  activityId?: string
}

interface UserDataEntry {
  dataType: string
  subContentId: string
  data: string | null
}

interface UserDataPreload {
  channel: 'h5p-player'
  type: 'user-data'
  session: string
  saveInterval: number
  entries: UserDataEntry[]
  user?: { name: string; mail: string }
}

type UserDataDone = (error?: unknown, data?: unknown) => void

declare global {
  interface Window {
    H5P?: {
      externalDispatcher?: { on(name: string, handler: (event: { data?: { statement?: XapiStatement } }) => void): void }
      init?: () => void
      preventInit?: boolean
      jQuery?: (target: Document) => { ready(handler: () => void): void }
      newRunnable?: (library: unknown, contentId: unknown, attachTo?: unknown, skipResize?: boolean, extras?: RunnableExtras) => unknown
      getUserData?: (contentId: unknown, dataType: string, done: UserDataDone, subContentId?: unknown) => void
      setUserData?: (contentId: unknown, dataType: string, data: unknown, options?: { subContentId?: unknown; errorCallback?: (error: unknown) => void }) => void
      deleteUserData?: (contentId: unknown, dataType: string, subContentId?: unknown) => void
      getContentPath?: (contentId: unknown) => string
      /** The top-level instance of each content `H5P.init` created. */
      instances?: unknown[]
      trigger?: (instance: unknown, eventType: string) => void
    }
    H5PIntegration?: Integration
    H5PUpgrades?: Record<string, UpgradeTable | undefined>
    /** Left by `l10n.js`, which the frame document names before this script unless its language is English. */
    H5PRuntimeL10n?: unknown
  }
}

interface XapiStatement {
  verb?: { id?: string }
}

/** What `H5P.newRunnable` hands a content type's constructor as its third argument. */
interface RunnableExtras {
  standalone?: boolean
  isReportingEnabled?: boolean
}

const config = JSON.parse(document.getElementById('h5p-boot-config')!.textContent!) as BootConfig

// To this document's own origin, never '*': package ids are derived from the URL and so guessable,
// and a third-party page framing it would otherwise be handed every xAPI statement.
var post = function (message: object) {
  try { parent.postMessage(Object.assign({ channel: 'h5p-player', pkgId: config.pkgId }, message), location.origin); }
  catch (error) { /* a detached parent is not worth reporting */ }
};

// The worker cannot start a long job itself, so it asks this client and the element obliges.
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', function (event: MessageEvent) {
    var data = event.data;
    if (data && (data.type === 'need-job' || data.type === 'need-file')) {
      post({ type: 'relay', payload: data });
    }
  });
}

var root = document.getElementById('h5p-root')!;

// What the host asked for. A button whose target is missing stays off: an export button with no
// file to download and an embed button with no code to offer would both be broken buttons.
var custom: FrameOptions = config.options || {};
var flag = function (value: boolean | undefined, otherwise: boolean) {
  return typeof value === 'boolean' ? value : otherwise;
};

// The core's strings in the frame's language when there are some (`l10n.js` is named for any but
// English), laid over the English key by key, before the ready handler builds the licence names.
var translations = coreTranslations(window.H5PRuntimeL10n, config.language);

/**
 * The content's id, a number the same on every load (Interactive Book and Cornell Notes need it,
 * #127): twelve hex digits of the package's id, which a double holds exactly.
 */
var contentIdOf = function (pkgId: string): number {
  return parseInt(String(pkgId).slice(0, 12), 16) || 1;
};

/**
 * The core's settings for this content, as a site's plugin writes them. `url` is the package's
 * root: the core adds `/content/<id>` only without a `contentUrl`, which `getContentPath` uses.
 */
var integrationFor = function (load: LibraryLoad, jsonContent: string, preload: UserDataPreload | null): Integration {
  var contentId = contentIdOf(config.pkgId);
  var base = config.h5pJsonPath;
  var file = function (path: string) { return base + '/' + path; };
  var content: IntegrationContent & Record<string, unknown> = {
    library: load.library,
    title: config.title || '',
    // The statements' object id. The element sets the package URL unless the host named another;
    // a picked file has none, and keeps the package's root on the virtual server.
    url: custom.activityId || base,
    contentUrl: base + '/content',
    jsonContent: jsonContent,
    // The host's stylesheets and scripts after the libraries', so that they can override them.
    styles: load.styles.map(file).concat(custom.customCss || []),
    scripts: load.scripts.map(file).concat(custom.customJs || []),
    fullScreen: flag(custom.fullScreen, true),
    exportUrl: custom.downloadUrl,
    embedCode: custom.embedCode || '',
    resizeCode: (custom.embedCode && custom.resizeCode) || '',
    displayOptions: {
      frame: flag(custom.frame, false),
      copyright: flag(custom.copyright, false),
      icon: flag(custom.icon, false),
      export: Boolean(custom.downloadUrl) && flag(custom.export, false),
      embed: Boolean(custom.embedCode) && flag(custom.embed, false),
      copy: false
    },
    // The package's own account of itself, which the worker read off `h5p.json`; one that has
    // none is "Undisclosed", as a platform saves content without a licence.
    metadata: config.metadata || { title: config.title || '', license: 'U' }
  };
  var integration: Integration = {
    baseUrl: location.origin,
    url: base,
    urlLibraries: base,
    libraryDirectories: load.directories || {},
    contents: {},
    // A number: the runtime asks the content for its state that often and saves as the document
    // goes away, on the value it sees when its ready handler runs, so the element is asked first.
    saveFreq: preload && resume && preload.saveInterval ? preload.saveInterval : false,
    // No result endpoint exists here. xAPI leaves as events; nothing is posted.
    postUserStatistics: false,
    reportingIsEnabled: flag(custom.reportingIsEnabled, false),
    ajax: {},
    l10n: { H5P: Object.assign({}, ENGLISH, translations ? translations.H5P : {}) },
    core: { scripts: [config.frameJs], styles: [config.frameCss] }
  };
  if (preload && preload.user) integration.user = preload.user;
  integration.contents['cid-' + contentId] = content;
  return integration;
};

/**
 * A `.h5p-content` in a `.h5p-iframe` wrapper, as a plugin writes a div embed. Div, not iframe:
 * whether an inner `about:blank` child inherits the Service Worker controller differs by browser.
 */
var mountContent = function (integration: Integration) {
  var wrapper = document.createElement('div');
  wrapper.className = 'h5p-iframe';
  var content = document.createElement('div');
  content.className = 'h5p-content';
  content.setAttribute('data-content-id', Object.keys(integration.contents)[0].slice('cid-'.length));
  wrapper.appendChild(content);
  root.appendChild(wrapper);
};

/** Stylesheets, added in order and not waited for, each marked as the core's own. */
var addStyles = function (urls: string[]) {
  urls.forEach(function (url) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.dataset.h5p = url;
    document.head.appendChild(link);
  });
};

/**
 * Scripts, in order: not async, so they run as added while fetched at once. Each is marked so the
 * listener at the end of the file reports a failed load, which nothing else would end the wait on.
 */
var addScripts = function (urls: string[]): Promise<void> {
  return Promise.all(
    urls.map(function (url) {
      var script = document.createElement('script');
      script.src = url;
      script.async = false;
      script.dataset.h5p = url;
      var loaded = new Promise<void>(function (resolve) {
        script.onload = function () { resolve(); };
      });
      document.head.appendChild(script);
      return loaded;
    })
  ).then(function () { return undefined; });
};

/** What to load, from the worker; its refusal, which names what is missing, as the error. */
var readLoad = function (): Promise<LibraryLoad> {
  return fetch(config.boot!).then(function (response) {
    if (response.ok) return response.json() as Promise<LibraryLoad>;
    return response.text().then(function (reason) {
      throw new Error(reason || 'The player could not say what to load (' + response.status + ')');
    });
  });
};

/**
 * The content's parameters, as the core takes them: a string. For a package played `untrusted`
 * asked for with `CONTENT_CHECK_HEADER`, without which the worker serves none.
 */
var readContent = function (): Promise<string> {
  var init: RequestInit = { credentials: 'same-origin' };
  if (config.untrusted) init.headers = { [CONTENT_CHECK_HEADER]: 'semantics' };
  return fetch(config.h5pJsonPath + '/content/content.json', init)
    .then(function (response) {
      if (!response.ok) throw new Error('content/content.json could not be read (' + response.status + ')');
      return response.json();
    })
    .then(function (params: unknown) { return JSON.stringify(params); });
};

/**
 * Whether the element opened this frame with `resume`, in the URL rather than the boot
 * configuration so an element or worker older than the other boots as before.
 */
var resume = /[?&]resume=1(?:&|$)/.test(location.search);
/** Whether the element has a learner to name; the same reply carries it, so the frame asks for it the same way. */
var wantsUser = /[?&]user=1(?:&|$)/.test(location.search);

/**
 * The user-data functions talk to the element, not a site's AJAX endpoint or a signed-in
 * `H5PIntegration.user` (that would rewrite every actor), keeping the runtime's semantics.
 */
var installUserData = function (preload: UserDataPreload) {
  var H5P = window.H5P!;
  var known: Record<string, string | null> = {};
  for (var i = 0; i < preload.entries.length; i++) {
    var entry = preload.entries[i];
    known[entry.dataType + '/' + entry.subContentId] = entry.data;
  }
  var keyOf = function (dataType: string, subContentId: unknown) {
    return dataType + '/' + String(subContentId || 0);
  };
  var save = function (dataType: string, subContentId: unknown, data: string | null) {
    post({ type: 'user-data', session: preload.session, dataType: dataType, subContentId: String(subContentId || 0), data: data });
  };

  H5P.getUserData = function (_contentId, dataType, done, subContentId) {
    var value = known[keyOf(dataType, subContentId)];
    if (value === undefined) return done();
    if (value === null) return done(undefined, null);
    try { done(undefined, JSON.parse(value)); } catch (error) { done(error); }
  };
  H5P.setUserData = function (_contentId, dataType, data, userOptions) {
    var opts = userOptions || {};
    var json: string;
    try { json = JSON.stringify(data); } catch (error) { if (opts.errorCallback) opts.errorCallback(error); return; }
    var key = keyOf(dataType, opts.subContentId);
    if (json === known[key]) return;
    known[key] = json;
    save(dataType, opts.subContentId, json);
  };
  H5P.deleteUserData = function (_contentId, dataType, subContentId) {
    delete known[keyOf(dataType, subContentId)];
    save(dataType, subContentId, null);
  };
};

/** Asks the element for the saved state and waits for it; nothing to wait for without `resume`. */
var askForUserData = function (): Promise<UserDataPreload | null> {
  if (!resume && !wantsUser) return Promise.resolve(null);
  return new Promise(function (resolve) {
    var onMessage = function (event: MessageEvent) {
      var data = event.data as UserDataPreload | undefined;
      if (event.origin !== location.origin || event.source !== parent) return;
      if (!data || data.channel !== 'h5p-player' || data.type !== 'user-data') return;
      window.removeEventListener('message', onMessage);
      resolve(data);
    };
    window.addEventListener('message', onMessage);
    post({ type: 'need-user-data' });
  });
};

/**
 * Where the upgrade learns what runs: `library.json` names the version that answered (a newer
 * minor, or the bare name); `upgrades.js` is fetched only from a folder the worker listed.
 */
var librarySource = function (base: string, listed: string[]): UpgradeSource & { semantics(folder: string): Promise<SemanticField[] | null> } {
  var served: Record<string, Promise<ServedLibrary | null>> = {};
  var steps: Record<string, Promise<UpgradeTable | null>> = {};
  var semantics: Record<string, Promise<SemanticField[] | null>> = {};

  var readLibrary = function (folder: string, machineName: string): Promise<ServedLibrary | null> {
    // Bounded, and a timeout fails the upgrade, not "not served": without `Range` a miss waits
    // until the download proves the entry absent, holding the boot back that long.
    return boundedFetch(base + '/' + folder + '/library.json')
      .then(function (response) {
        // Not JSON is not a library; the runtime fails on it in its own way.
        return response.ok ? response.json().catch(function () { return null; }) : null;
      })
      .then(function (library: { machineName?: unknown; majorVersion?: unknown; minorVersion?: unknown } | null) {
        if (!library || library.machineName !== machineName) return null;
        var major = Number(library.majorVersion);
        var minor = Number(library.minorVersion);
        if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
        // A versioned name is answered from the folder of the version served, which is where its
        // `upgrades.js` is; a bare one is a folder of its own.
        return { major: major, minor: minor, folder: folder === machineName ? folder : machineName + '-' + major + '.' + minor };
      });
  };

  return {
    semantics: function (folder: string): Promise<SemanticField[] | null> {
      if (!semantics[folder]) {
        // Bounded like a library.json, and nothing, rather than an error, for one that is not
        // there: the check removes sub-content it cannot check, and refuses a main library.
        semantics[folder] = boundedFetch(base + '/' + folder + '/semantics.json')
          .then(function (response) { return response.ok ? response.json() : null; })
          .then(function (fields: unknown) { return Array.isArray(fields) ? (fields as SemanticField[]) : null; })
          .catch(function () { return null; });
      }
      return semantics[folder];
    },
    served: function (machineName, wanted) {
      var versioned = machineName + '-' + wanted.major + '.' + wanted.minor;
      if (!served[versioned]) {
        served[versioned] = readLibrary(versioned, machineName).then(function (found) {
          return found || readLibrary(machineName, machineName);
        });
      }
      return served[versioned];
    },
    steps: function (machineName, library) {
      if (listed.indexOf(library.folder) < 0) return Promise.resolve(null);
      var url = base + '/' + library.folder + '/upgrades.js';
      if (!steps[url]) {
        steps[url] = boundedFetch(url).then(function (response) {
          if (!response.ok) throw new Error('could not load ' + library.folder + '/upgrades.js (' + response.status + ')');
          return response.text().then(function (code) {
            // Evaluated, not added as a script, as platforms use `importScripts` in a try: a throw
            // then fails the upgrade, not the boot (the error listener below would report it).
            window.H5PUpgrades = window.H5PUpgrades || {};
            (0, eval)(code + '\n//# sourceURL=' + url);
            return window.H5PUpgrades[machineName] || null;
          });
        });
      }
      return steps[url];
    }
  };
};

/**
 * Where the upgrade and the check learn what is served, shared so a library is asked for once; set
 * once the worker has said which folders carry an `upgrades.js`.
 */
var libraries: ReturnType<typeof librarySource>;

interface Manifest {
  mainLibrary?: unknown
  preloadedDependencies?: { machineName?: unknown; majorVersion?: unknown; minorVersion?: unknown }[]
}

var manifestRead: Promise<Manifest> | undefined;
var readManifest = function (): Promise<Manifest> {
  if (!manifestRead) manifestRead = fetch(config.h5pJsonPath + '/h5p.json').then(function (response) { return response.json(); });
  return manifestRead;
};

/**
 * The main library as the content was written for it, from `h5p.json`: its name held to the shape
 * a library string has, since it goes into URLs and a source name. `null` for a manifest without one.
 */
var writtenFor = function (manifest: Manifest): LibraryName | null {
  var main = (manifest.preloadedDependencies || []).filter(function (each) { return each.machineName === manifest.mainLibrary; })[0];
  if (!main || typeof main.machineName !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(main.machineName)) return null;
  var major = Number(main.majorVersion);
  var minor = Number(main.minorVersion);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  return { machineName: main.machineName, major: major, minor: minor };
};

/**
 * Brings the parameters up to the library versions served, before the runtime reads them, as
 * platforms do. A failure leaves them as written, as before this ran, and says so in the console.
 */
var upgradeToServed = function (): Promise<void> {
  // `const`, so the check below still holds inside the callbacks that follow.
  const content = registeredContent();
  if (!content) return Promise.resolve();

  return readManifest()
    .then(function (manifest) {
      // The version the content was written for. The one `H5PIntegration` names is the version
      // served, read off the library.json that answered.
      var main = writtenFor(manifest);
      if (!main) return;

      // Copies, both: a step may change what it is handed in place before a later one fails, and
      // a failure has to leave the content exactly as written.
      return upgradeContent(
        { machineName: main.machineName, version: { major: main.major, minor: main.minor } },
        JSON.parse(content.jsonContent),
        content.metadata === undefined ? undefined : JSON.parse(JSON.stringify(content.metadata)),
        libraries
      ).then(function (result) {
        // The version served, in full: a name without a minor of 0 ("H5P.Accordion 1") becomes the
        // folder `H5P.Accordion-1.undefined`, which every statement's category then carries.
        if (result.library) content.library = result.library;
        if (result.changed) {
          content.jsonContent = JSON.stringify(result.params);
          if (result.metadata) content.metadata = result.metadata;
        }
      });
    })
    .catch(function (error: unknown) {
      console.error('<h5p-player>: the content could not be brought up to the library versions served, and plays as written:', error);
    });
};

/**
 * For `untrusted` packages: the content checked against the served semantics (`content-check.ts`),
 * after the upgrade, before `H5P.init` reads it. Content that cannot be checked does not play.
 */
var checkUntrusted = function (): Promise<void> {
  if (!config.untrusted) return Promise.resolve();
  // `const`, so the check below still holds inside the callbacks that follow.
  const content = registeredContent();
  if (!content) return Promise.reject(new Error('the runtime holds no content to check'));

  return readManifest()
    .then(function (manifest) {
      var main = writtenFor(manifest);
      if (!main) throw new Error('h5p.json names no main library');
      return libraries.served(main.machineName, { major: main.major, minor: main.minor }).then(function (served) {
        if (!served) throw new Error('the library sources do not serve ' + main!.machineName);
        var library = main!.machineName + ' ' + served.major + '.' + served.minor;
        var params: unknown = JSON.parse(content.jsonContent);
        var wanted = [parseLibrary(library)!].concat(librariesIn(params));
        return Promise.all(
          wanted.map(function (name) {
            return libraries.served(name.machineName, { major: name.major, minor: name.minor }).then(function (found) {
              return found ? libraries.semantics(found.folder) : null;
            }).then(function (fields) { return [libraryKey(name), fields] as const; });
          })
        ).then(function (entries) {
          var checked = checkContent(library, params, new Map(entries));
          var metadata = checkContentMetadata(content.metadata);
          content.jsonContent = JSON.stringify(checked.params);
          content.metadata = metadata.metadata;
          content.library = library;
          var messages = checked.messages.concat(metadata.messages);
          if (messages.length) {
            console.warn("<h5p-player>: the content was checked against its libraries' semantics, as the H5P platforms check it, and changed:\n- " + messages.join('\n- '));
          }
        });
      });
    })
    .catch(function (error: unknown) {
      throw new Error("The content could not be checked against its libraries' semantics, so it does not play untrusted: " + errorText(error));
    });
};

/**
 * The core and the libraries in place. `preventInit` is set before the core loads, or its ready
 * handler would initialise before the saved state is in.
 */
var bootCore = function (preload: UserDataPreload | null): Promise<void> {
  if (!config.boot) {
    return Promise.reject(new Error("The player's Service Worker is older than this runtime: it pairs with @missing-elements/h5p-runtime 0.2. Update the player, its element and h5p-sw.js together, to the release that names this runtime."));
  }
  return Promise.all([readLoad(), readContent()]).then(function (answers) {
    var load = answers[0];
    libraries = librarySource(config.h5pJsonPath, load.upgrades);
    var integration = integrationFor(load, answers[1], preload);
    window.H5PIntegration = integration;
    window.H5P = window.H5P || {};
    window.H5P.preventInit = true;
    mountContent(integration);
    var content = integration.contents[Object.keys(integration.contents)[0]];
    addStyles(integration.core.styles.concat(content.styles as string[]));
    return addScripts(integration.core.scripts.concat(content.scripts as string[]));
  });
};

askForUserData()
  .then(function (preload) {
    return bootCore(preload).then(function () {
      // Whenever the element answered, not only under `resume`: with a user set the runtime sends
      // user-data calls to an AJAX URL that does not exist here, and the boot died on it.
      if (preload) installUserData(preload);
    });
  })
  // The scripts are in and the content's parameters are in `H5PIntegration`, not yet read.
  .then(upgradeToServed)
  .then(checkUntrusted)
  .then(function (): Promise<void> {
    // Behind the core's ready handler, which builds `H5P.copyrightLicenses`: initialised before it,
    // a package whose licence is not "Undisclosed" died on `copyrightLicenses['MIT']`.
    var H5P = window.H5P!;
    return new Promise(function (resolve) {
      if (H5P.jQuery) H5P.jQuery(document).ready(function () { resolve(); });
      else resolve();
    });
  })
  .then(function () {
    // The core's own start, which `preventInit` held back.
    var H5P = window.H5P!;
    // This core never sets `extras.isReportingEnabled` as h5p.com's does, but Question Set,
    // Interactive Video, Course Presentation and Game Map read it: the `standalone` one gets it.
    if (window.H5PIntegration!.reportingIsEnabled && typeof H5P.newRunnable === 'function') {
      var newRunnable = H5P.newRunnable;
      H5P.newRunnable = function (library, contentId, attachTo, skipResize, extras) {
        if (extras && extras.standalone) extras.isReportingEnabled = true;
        return newRunnable.call(H5P, library, contentId, attachTo, skipResize, extras);
      };
    }
    // The core builds a content's folder as `url + '/content/' + id`, not where the package keeps
    // it, so this reads `contentUrl` first, as `getPath` does.
    var getContentPath = H5P.getContentPath;
    if (typeof getContentPath === 'function') {
      H5P.getContentPath = function (contentId) {
        var contents = window.H5PIntegration && window.H5PIntegration.contents;
        var content = contents && contents['cid-' + contentId];
        return content && content.contentUrl ? content.contentUrl : getContentPath!.call(H5P, contentId);
      };
    }
    if (typeof H5P.init === 'function') H5P.init();
    H5P.preventInit = false;

    var dispatcher = H5P.externalDispatcher;
    if (dispatcher) {
      dispatcher.on('xAPI', function (event) {
        var statement = event && event.data ? event.data.statement : undefined;
        var verb = statement && statement.verb ? statement.verb.id : undefined;
        post({ type: 'xapi', statement: statement, verb: verb });
        // H5P's own rule for a result: `completed` or `answered`, from the content itself.
        if (isResult(statement)) {
          post({ type: 'finished', statement: statement });
        }
      });
    }
    // Sizing is H5P's own, from content resize events; a font arriving raises none, so text
    // measured in the fallback face kept its height (47 px lost): resize all once faces load.
    var fonts = document.fonts;
    if (fonts && typeof H5P.trigger === 'function') {
      var afterFonts = function () {
        fonts.ready.then(function () {
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              (H5P.instances || []).forEach(function (instance) {
                H5P.trigger!(instance, 'resize');
              });
            });
          });
        });
      };
      // On `loading`, as WebKit never fires `loadingdone`; two frames after `ready`, as WebKit
      // resolves it before its layout has taken the face.
      fonts.addEventListener('loading', afterFonts);
      if (fonts.status === 'loading') afterFonts();
    }
    post({ type: 'ready' });
  })
  .catch(function (error: unknown) {
    post({ type: 'error', message: errorText(error) });
  });

// Capture phase: a failed resource's 'error' does not bubble and the loader waits on 'load' alone,
// so a lost library would hang the boot. Only tags marked data-h5p count.
window.addEventListener('error', function (event: Event) {
  var target = event.target as (HTMLElement & { src?: string; href?: string }) | null;
  if (target && target !== (window as unknown)) {
    if (!(target.dataset && target.dataset.h5p)) return;
    var url = String(target.src || target.href || '').replace(location.origin, '');
    var root = String(config.h5pJsonPath).replace(location.origin, '') + '/';
    var shown = url.indexOf(root) === 0 ? url.slice(root.length) : url;
    post({ type: 'error', message: 'Could not load ' + shown });
    return;
  }
  post({ type: 'error', message: String((event as ErrorEvent).message || 'Script error in H5P content') });
}, true);

export {}

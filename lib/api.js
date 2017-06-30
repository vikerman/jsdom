"use strict";
const path = require("path");
const sniffHTMLEncoding = require("html-encoding-sniffer");
const whatwgURL = require("whatwg-url");
const whatwgEncoding = require("whatwg-encoding");
const { URL } = require("whatwg-url");
const parseContentType = require("content-type-parser");
const idlUtils = require("./jsdom/living/generated/utils.js");
const VirtualConsole = require("./jsdom/virtual-console.js");
const Window = require("./jsdom/browser/Window.js");
const { locationInfo } = require("./jsdom/living/helpers/internal-constants.js");
const { domToHtml } = require("./jsdom/browser/domtohtml.js");
const { applyDocumentFeatures } = require("./jsdom/browser/documentfeatures.js");
const { version: packageVersion } = require("../package.json");

const DEFAULT_USER_AGENT = `Mozilla/5.0 (${process.platform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
                           `jsdom/${packageVersion}`;

// This symbol allows us to smuggle a non-public option through to the JSDOM constructor, for use by JSDOM.fromURL.
const transportLayerEncodingLabelHiddenOption = Symbol("transportLayerEncodingLabel");
class CookieJar {
  constructor(store, options) {
  }
}

const window = Symbol("window");
let sharedFragmentDocument = null;

class JSDOM {
  constructor(input, options = {}) {
    const { html, encoding } = normalizeHTML(input, options[transportLayerEncodingLabelHiddenOption]);
    options = transformOptions(options, encoding);

    this[window] = new Window(options.windowOptions);

    // TODO NEWAPI: the whole "features" infrastructure is horrible and should be re-built. When we switch to newapi
    // wholesale, or perhaps before, we should re-do it. For now, just adapt the new, nice, public API into the old,
    // ugly, internal API.
    const features = {
      FetchExternalResources: [],
      SkipExternalResources: false
    };

    if (options.resources === "usable") {
      features.FetchExternalResources = ["link", "img", "frame", "iframe"];
      if (options.windowOptions.runScripts === "dangerously") {
        features.FetchExternalResources.push("script");
      }

      // Note that "img" will be ignored by the code in HTMLImageElement-impl.js if canvas is not installed.
      // TODO NEWAPI: clean that up and centralize the logic here.
    }

    const documentImpl = idlUtils.implForWrapper(this[window]._document);
    applyDocumentFeatures(documentImpl, features);

    options.beforeParse(this[window]._globalProxy);

    // TODO NEWAPI: this is still pretty hacky. It's also different than jsdom.jsdom. Does it work? Can it be better?
    documentImpl._htmlToDom.appendToDocument(html, documentImpl);
    documentImpl.close();
  }

  get window() {
    // It's important to grab the global proxy, instead of just the result of `new Window(...)`, since otherwise things
    // like `window.eval` don't exist.
    return this[window]._globalProxy;
  }

  get virtualConsole() {
    return this[window]._virtualConsole;
  }

  get cookieJar() {
    // TODO NEWAPI move _cookieJar to window probably
    return idlUtils.implForWrapper(this[window]._document)._cookieJar;
  }

  serialize() {
    return domToHtml([this[window]._document]);
  }

  nodeLocation(node) {
    if (!idlUtils.implForWrapper(this[window]._document)._parseOptions.locationInfo) {
      throw new Error("Location information was not saved for this jsdom. Use includeNodeLocations during creation.");
    }

    return idlUtils.implForWrapper(node)[locationInfo];
  }

  reconfigure(settings) {
    if ("windowTop" in settings) {
      this[window]._top = settings.windowTop;
    }

    if ("url" in settings) {
      const document = idlUtils.implForWrapper(this[window]._document);

      const url = whatwgURL.parseURL(settings.url);
      if (url === null) {
        throw new TypeError(`Could not parse "${settings.url}" as a URL`);
      }

      document._URL = url;
      document._origin = whatwgURL.serializeURLOrigin(document._URL);
    }
  }

  static fragment(string) {
    if (!sharedFragmentDocument) {
      sharedFragmentDocument = (new JSDOM()).window.document;
    }

    const template = sharedFragmentDocument.createElement("template");
    template.innerHTML = string;
    return template.content;
  }
}

function transformOptions(options, encoding) {
  const transformed = {
    windowOptions: {
      // Defaults
      url: "about:blank",
      referrer: "",
      contentType: "text/html",
      parsingMode: "html",
      userAgent: DEFAULT_USER_AGENT,
      parseOptions: { locationInfo: false },
      runScripts: undefined,
      encoding,

      // Defaults filled in later
      virtualConsole: undefined,
      cookieJar: undefined
    },

    // Defaults
    resources: undefined,
    beforeParse() { }
  };

  if (options.contentType !== undefined) {
    const contentTypeParsed = parseContentType(options.contentType);
    if (contentTypeParsed === null) {
      throw new TypeError(`Could not parse the given content type of "${options.contentType}"`);
    }

    if (!contentTypeParsed.isHTML() && !contentTypeParsed.isXML()) {
      throw new RangeError(`The given content type of "${options.contentType}" was not a HTML or XML content type`);
    }

    transformed.windowOptions.contentType = contentTypeParsed.type + "/" + contentTypeParsed.subtype;
    transformed.windowOptions.parsingMode = contentTypeParsed.isHTML() ? "html" : "xml";
  }

  if (options.url !== undefined) {
    transformed.windowOptions.url = (new URL(options.url)).href;
  }

  if (options.referrer !== undefined) {
    transformed.windowOptions.referrer = (new URL(options.referrer)).href;
  }

  if (options.userAgent !== undefined) {
    transformed.windowOptions.userAgent = String(options.userAgent);
  }

  if (options.includeNodeLocations) {
    if (transformed.windowOptions.parsingMode === "xml") {
      throw new TypeError("Cannot set includeNodeLocations to true with an XML content type");
    }

    transformed.windowOptions.parseOptions = { locationInfo: true };
  }

  transformed.windowOptions.cookieJar = options.cookieJar;

  transformed.windowOptions.virtualConsole = options.virtualConsole === undefined ?
                                            (new VirtualConsole()).sendTo(console) :
                                            options.virtualConsole;

  if (options.resources !== undefined) {
    transformed.resources = String(options.resources);
    if (transformed.resources !== "usable") {
      throw new RangeError(`resources must be undefined or "usable"`);
    }
  }

  if (options.runScripts !== undefined) {
    transformed.windowOptions.runScripts = String(options.runScripts);
    if (transformed.windowOptions.runScripts !== "dangerously" &&
        transformed.windowOptions.runScripts !== "outside-only") {
      throw new RangeError(`runScripts must be undefined, "dangerously", or "outside-only"`);
    }
  }

  if (options.beforeParse !== undefined) {
    transformed.beforeParse = options.beforeParse;
  }

  // concurrentNodeIterators??

  return transformed;
}

function normalizeHTML(html = "", transportLayerEncodingLabel) {
  let encoding = "UTF-8";

  if (ArrayBuffer.isView(html)) {
    html = Buffer.from(html.buffer, html.byteOffset, html.byteLength);
  } else if (html instanceof ArrayBuffer) {
    html = Buffer.from(html);
  }

  if (Buffer.isBuffer(html)) {
    encoding = sniffHTMLEncoding(html, { defaultEncoding: "windows-1252", transportLayerEncodingLabel });
    html = whatwgEncoding.decode(html, encoding);
  } else {
    html = String(html);
  }

  return { html, encoding };
}

exports.JSDOM = JSDOM;

exports.VirtualConsole = VirtualConsole;
exports.CookieJar = CookieJar;

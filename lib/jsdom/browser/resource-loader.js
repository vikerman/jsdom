"use strict";

exports.readFile = function (filePath, options, callback) {
  throw new Error('not implemented');
};

exports.wrapCookieJarForRequest = cookieJar => {
  throw new Error('not implemented');
};

exports.enqueue = function (element, resourceUrl, callback) {
  return () => {};
};

exports.download = function (url, options, callback) {
  throw new Error('not implemented');
};

exports.load = function (element, urlString, options, callback) {
}
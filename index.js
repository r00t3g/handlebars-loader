var loaderUtils = require("loader-utils"),
    handlebars = require("handlebars"),
    async = require("async"),
    util = require("util"),
    path = require("path"),
    fs = require("fs"),
    sha1 = require("sha1"),
    fastreplace = require('./lib/fastreplace'),
    findNestedRequires = require('./lib/findNestedRequires'),
    glob = require("glob");

function versionCheck(hbCompiler, hbRuntime) {
    return hbCompiler.COMPILER_REVISION === (hbRuntime["default"] || hbRuntime).COMPILER_REVISION;
}

module.exports = function (source) {

    if (this.cacheable) this.cacheable();

    var loaderApi = this,
        rootStripRx = new RegExp("(" + this._compiler.options.resolve.root + "/" + this._compiler.options.resolve.modulesDirectories.join(")|(" + this._compiler.options.resolve.root + "/") + ")", "g"),
        resourcePath = this.resourcePath,
        query = this.query instanceof Object ? this.query : loaderUtils.parseQuery(this.query),
        runtimePath = query.runtime || require.resolve("handlebars/runtime"),
        _compiler = this._compiler;

    if (query.cache) {
        var
            resourceMod = fs.statSync(resourcePath).mtime,
            resourceHash = sha1(resourcePath),
            cachePath = path.join(query.cache, resourceHash + ".hbs.compiled"),
            cachedSlug = null,
            cachedSlugTime = null;

        try {
            fs.mkdirSync(query.cache);
        } catch (e) {
        }

        if (fs.existsSync(cachePath)) {
            cachedSlugTime = fs.statSync(cachePath).mtime;
            if (cachedSlugTime > resourceMod) {
                cachedSlug = fs.readFileSync(cachePath);
                process.stderr.write(" Fetched HBS slug from cache: " + path.basename(resourcePath) + " - " + path.basename(cachePath) + "\n");
                var loaderAsyncCallback = this.async();
                loaderAsyncCallback(null, cachedSlug);
                return;
            }
        }
    }

    if (!versionCheck(handlebars, require(runtimePath))) {
        throw new Error('Handlebars compiler version does not match runtime version');
    }

    // Possible extensions for partials
    var extensions = query.extensions;
    if (!extensions) {
        extensions = [".handlebars", ".hbs", ""];
    }
    else if (!Array.isArray(extensions)) {
        extensions = extensions.split(/[ ,;]/g);
    }

    var rootRelative = query.rootRelative;
    if (rootRelative == null) {
        rootRelative = "./";
    }

    _compiler.hbsData = {};
    var foundPartials = {};
    var foundHelpers = _compiler.hbsData.foundHelpers = _compiler.hbsData.foundHelpers || {};
    var foundUnclearStuff = {};
    var knownHelpers = _compiler.hbsData.knownHelpers = _compiler.hbsData.knownHelpers || {};

    var queryKnownHelpers = query.knownHelpers;
    if (queryKnownHelpers) {
        [].concat(queryKnownHelpers).forEach(function (k) {
            knownHelpers[k] = true;
        });
    }

    for (var helperName in handlebars.helpers) {
        if (handlebars.helpers.hasOwnProperty(helperName)) {
            knownHelpers[helperName] = true;
        }
    }

    var inlineRequires = query.inlineRequires;
    if (inlineRequires) {
        inlineRequires = new RegExp(inlineRequires);
    }

    var exclude = query.exclude;
    if (exclude) {
        exclude = new RegExp(exclude);
    }

    var debug = query.debug;

    var hb = _compiler.hbsData.hb = _compiler.hbsData.hb || handlebars.create();

    if (!_compiler.hbsData.helpersRead && query.helperDirs && query.helperDirs.length) {
        query.helperDirs.forEach(function (helperDir) {
            var helpers = glob.sync(helperDir + "/*.js");
            helpers.forEach(function (helperPath) {
                var helperName = path.basename(helperPath).replace(/\.js$/, "");

                knownHelpers[helperName] = true;
                foundHelpers["$" + helperName] = helperPath;
            });
        });
        _compiler.hbsData.helpersRead = true;
    }

    var JavaScriptCompiler = hb.JavaScriptCompiler;

    function MyJavaScriptCompiler() {
        JavaScriptCompiler.apply(this, arguments);
    }

    MyJavaScriptCompiler.prototype = Object.create(JavaScriptCompiler.prototype);
    MyJavaScriptCompiler.prototype.compiler = MyJavaScriptCompiler;
    MyJavaScriptCompiler.prototype.nameLookup = function (parent, name, type) {
        if (debug) {
            console.log("nameLookup %s %s %s", parent, name, type);
        }
        if (type === "partial") {
            if (name[0] == '@') {
                // this is a built in partial, no need to require it
                return JavaScriptCompiler.prototype.nameLookup.apply(this, arguments);
            }
            if (foundPartials["$" + name]) {
                return "require(" + JSON.stringify(foundPartials["$" + name]) + ")";
            }
            foundPartials["$" + name] = null;
            return JavaScriptCompiler.prototype.nameLookup.apply(this, arguments);
        }
        else if (type === "helper") {
            if (foundHelpers["$" + name]) {
                return "__default(require(" + JSON.stringify(foundHelpers["$" + name]) + "))";
            }
            foundHelpers["$" + name] = null;
            return JavaScriptCompiler.prototype.nameLookup.apply(this, arguments);
        }
        else if (type === "context") {
            // This could be a helper too, save it to check it later
            if (!foundUnclearStuff["$" + name] && name in handlebars.helpers) foundUnclearStuff["$" + name] = false;
            return JavaScriptCompiler.prototype.nameLookup.apply(this, arguments);
        }
        else {
            return JavaScriptCompiler.prototype.nameLookup.apply(this, arguments);
        }
    };

    if (inlineRequires) {
        MyJavaScriptCompiler.prototype.pushString = function (value) {
            if (inlineRequires.test(value)) {
                this.pushLiteral("require(" + JSON.stringify(value) + ")");
            } else {
                JavaScriptCompiler.prototype.pushString.call(this, value);
            }
        };
        MyJavaScriptCompiler.prototype.appendToBuffer = function (str) {
            // This is a template (stringified HTML) chunk
            if (str.indexOf && str.indexOf('"') === 0) {
                var replacements = findNestedRequires(str, inlineRequires);
                str = fastreplace(str, replacements, function (match) {
                    return "\" + require(" + JSON.stringify(match) + ") + \"";
                });
            }
            return JavaScriptCompiler.prototype.appendToBuffer.apply(this, arguments);
        };
    }

    hb.JavaScriptCompiler = MyJavaScriptCompiler;

    // This is an async loader
    var loaderAsyncCallback = this.async();

    var firstCompile = true;
    var compilationPass = 0;

    (function compile() {
        if (debug) {
            console.log("\nCompilation pass %d", ++compilationPass);
        }

        function referenceToRequest(ref, type) {
            if (/^\$/.test(ref))
                return ref.substring(1);
            else if (type === 'helper' && query.helperDirs && query.helperDirs.length)
                return ref;
            else
                return rootRelative + ref;
        }

        // Need another compiler pass?
        var needRecompile = false;

        // Precompile template
        var template = '';

        try {
            if (source) {
                template = hb.precompile(source, {
                    knownHelpersOnly: (query.helperDirs && query.helperDirs.length) ? true : false,
                    knownHelpers: knownHelpers
                }).replace(/\\[rn]/g,"").replace(/\s{2,}/g, " ").replace(/>\s+</g, "><");
            }
        } catch (err) {
            return loaderAsyncCallback(err);
        }

        var resolve = function (request, type, callback) {
            var contexts = [loaderApi.context];

            // Any additional helper dirs will be added to the searchable contexts
            if (query.helperDirs) {
                contexts = contexts.concat(query.helperDirs);
            }

            var resolveWithContexts = function () {
                var context = contexts.shift();

                var traceMsg;
                if (debug) {
                    traceMsg = path.normalize(path.join(context, request));
                    console.log("Attempting to resolve %s %s", type, traceMsg);
                    console.log("request=%s", request);
                }

                var next = function (err) {
                    if (contexts.length > 0) {
                        resolveWithContexts();
                    }
                    else {
                        if (debug) console.log("Failed to resolve %s %s", type, traceMsg);
                        return callback(err);
                    }
                };

                loaderApi.resolve(context, request, function (err, result) {
                    if (!err && result) {
                        if (exclude && exclude.test(result)) {
                            if (debug) console.log("Excluding %s %s", type, traceMsg);
                            return next();
                        }
                        else {
                            if (debug) console.log("Resolved %s %s", type, traceMsg);
                            return callback(err, result);
                        }
                    } else {
                        return next(err);
                    }
                });
            };

            resolveWithContexts();
        };

        var resolveUnclearStuffIterator = function (stuff, unclearStuffCallback) {
            if (foundUnclearStuff[stuff]) return unclearStuffCallback();
            var request = referenceToRequest(stuff.substr(1), 'unclearStuff');
            resolve(request, 'unclearStuff', function (err, result) {
                if (!err && result) {
                    knownHelpers[stuff.substr(1)] = true;
                    foundHelpers[stuff] = result;
                    needRecompile = true;
                }
                foundUnclearStuff[stuff] = true;
                unclearStuffCallback();
            });
        };

        var resolvePartialsIterator = function (partial, partialCallback) {
            if (foundPartials[partial]) return partialCallback();
            var request = referenceToRequest(partial.substr(1), 'partial');

            // Try every extension for partials
            var i = 0;
            (function tryExtension() {
                if (i > extensions.length) {
                    var errorMsg = util.format("Partial '%s' not found", partial.substr(1));
                    return partialCallback(new Error(errorMsg));
                }
                var extension = extensions[i++];

                resolve(request + extension, 'partial', function (err, result) {
                    if (!err && result) {
                        foundPartials[partial] = result;
                        needRecompile = true;
                        return partialCallback();
                    }
                    tryExtension();
                });
            }());
        };

        var resolveHelpersIterator = function (helper, helperCallback) {
            if (foundHelpers[helper]) return helperCallback();
            var request = referenceToRequest(helper.substr(1), 'helper');

            resolve(request, 'helper', function (err, result) {
                if (!err && result) {
                    knownHelpers[helper.substr(1)] = true;
                    foundHelpers[helper] = result;
                    needRecompile = true;
                    return helperCallback();
                }

                // We don't return an error: we just fail to resolve the helper.
                // This is b/c Handlebars calls nameLookup with type=helper for non-helper
                // template options, e.g. something that comes from the template data.
                helperCallback();
            });
        };

        var doneResolving = function (err) {
            if (err) return loaderAsyncCallback(err);

            // Do another compiler pass if not everything was resolved
            if (needRecompile) {
                firstCompile = false;
                return compile();
            }

            // export as module if template is not blank
            var cleanedResourcePath = resourcePath.replace(rootStripRx, "").replace(/\/tpl\//g, "/").replace(/^\//g, "");
            var slug = template ?
                       'var Handlebars = require(' + JSON.stringify(runtimePath) + ');\n'
                       + 'function __default(obj) { return obj && (obj.__esModule ? obj["default"] : obj); }\n'
                       + 'module.exports = (function($__hbsFileName){ return (Handlebars["default"] || Handlebars).template(' + template + '); })("'+cleanedResourcePath+'")' :
                       'module.exports = function(){return "";};';

            if (query.cache) {
                fs.writeFileSync(cachePath, slug);
            }
            loaderAsyncCallback(null, slug);
        };

        var resolvePartials = function (err) {
            if (err) return doneResolving(err);

            if (debug) {
                console.log("Attempting to resolve partials:");
                console.log(foundPartials);
            }

            // Resolve path for each partial
            async.forEach(Object.keys(foundPartials), resolvePartialsIterator, doneResolving);
        };

        var resolveUnclearStuff = function (err) {
            if (err) return resolvePartials(err);

            if (debug) {
                console.log("Attempting to resolve unclearStuff:");
                console.log(foundUnclearStuff);
            }

            // Check for each found unclear item if it is a helper
            async.forEach(Object.keys(foundUnclearStuff), resolveUnclearStuffIterator, resolvePartials);
        };

        var resolveHelpers = function (err) {
            if (err) throw resolveUnclearStuff(err);

            if (debug) {
                console.log("Attempting to resolve helpers:");
                console.log(foundHelpers);
            }

            // Resolve path for each helper
            async.forEach(Object.keys(foundHelpers), resolveHelpersIterator, resolveUnclearStuff);
        };

        resolveHelpers();
    }());
};

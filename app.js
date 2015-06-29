var fs = require('fs');
var archiver = require('archiver');
var express = require('express');
var multer = require('multer');
var unzip = require('unzip');
var path = require('path');
var cheerio = require('cheerio');
var es = require('event-stream');
var parse = require('csv-parse');

var app = express();

app.use(multer({
	dest: './uploads/',
	onFileUploadComplete: function (file, request, response) {
		// NOTE: request and response were null (?)
	}
}));

app.set('port', (process.env.PORT || 5010));

app.use(express.static('public'));

app.post('/upload', function(request, response) {
	console.log("request received:");
	console.log(request.files);

	if (request.files && request.files.file) {
		console.log("Upload received " + request.files.file.originalname);
		//console.log(request.body); // form fields
		//console.log(request.files); // form files

		var converted = doConversion({
			name: request.files.file.originalname,
			path: request.files.file.path,
			response: response,
			id: request.body.requestid,
			title: request.body.title
		});
	}
});

var http = require('http');
var server = http.Server(app);
var io = require('socket.io')(server);

var connections = [];

io.on('connection', function (socket) {
	socket.on("id", function (id) {
		connections.push( { socket: socket, id: id });
	});
});

server.listen((process.env.PORT || 5010), function () {
	console.log("video-toc-converter is running on port:" + app.get('port'));
});

function sendProgress (id, progress) {
	for (var i = 0; i < connections.length; i++) {
		var c = connections[i];
		if (c.id == id) {
			var obj = { progress: progress, id: id };
			c.socket.emit("progress", obj);
		}
	}
}

function deleteFolderRecursive (path) {
	if (fs.existsSync(path)) {
		fs.readdirSync(path).forEach(function (file, index) {
			var curPath = path + "/" + file;
			var d = fs.statSync(curPath);
			if (d.isDirectory()) {
				deleteFolderRecursive(curPath);
			} else { // delete file
				fs.unlinkSync(curPath);
			}
		});
		fs.rmdirSync(path);
	}
}

function makeAllPaths (dir) {
	var paths = dir.split(path.sep);

	var curPath = "";
	for (var i = 0; i < paths.length; i++) {
		curPath += paths[i] + path.sep;
		try {
			fs.accessSync(curPath, fs.W_OK);
		} catch (err) {
			fs.mkdirSync(curPath);
		}
	}
}

function doConversion (options) {
	options.timestamp = Date.now();

	var input = fs.readFileSync(options.path, "utf8");
	var parseOptions = { delimiter: "\t" };

	parse(input, parseOptions, function(err, output) {
		if (!err) {
			processData(options, output);

			callWhenComplete(options);
		} else {
			console.log("error");
			console.log(err);
		}
	});

	/*
	doExtraction(options, function () {
		processTOC(options);
		writeZip(options);
	});
	*/

	//return outputFile;
}

function processData (options, data) {
	var toc = [];

	var depth = undefined, lastMajor = undefined, minor = 0;

	for (var i = 0; i < data.length; i++) {
		var row = data[i];
		var obj = {};

		var duration = row[2];
		if (duration) {
			obj.isVideo = true;
			obj.duration = duration;
		} else {
			obj.isVideo = false;
		}

		var info = parseInfoFromText(row[0], row[1]);

		obj.short = info.short;
		obj.desc = info.desc;
		obj.major = info.major;

		var curDepth = depth;

		if (obj.major == "") {
			if (depth == undefined)
				depth = 0;
			else
				depth++;

			curDepth = depth;

			minor = 0;
		} else if (obj.major == lastMajor) {
			curDepth += "," + minor;
			minor++;
		} else {
			depth++;
			minor = 0;

			curDepth = depth;
		}

		obj.depth = curDepth;

		lastMajor = obj.major;

		toc.push(obj);
	}

	options.toc = toc;

	console.log(options.toc);
}

function parseInfoFromText (filename, description) {
	var obj = { short: "", desc: "", major: "" };

	var reg, res;

	// Part X: Part title
	reg = /Part (.*):\s(.*)/;
	res = reg.exec(filename);

	if (res) {
		obj.short = res[1];
		obj.major = "";
	} else {
		// Lesson X: Lesson title
		reg = /Lesson (.*):\s(.*)/;
		res = reg.exec(filename);

		if (res) {
			obj.short = res[1];
			obj.major = res[1];
		} else {
			// Lesson_X_Y
			reg = /Lesson_(.*)_(.*)/;
			res = reg.exec(filename);

			if (res) {
				obj.short = res[1] + "." + res[2];
				obj.major = res[1];
			}
		}
	}

	// Part X: Part title
	reg = /Part (.*):\s(.*)/;
	res = reg.exec(description);

	if (res) {
		obj.desc = res[2];
	} else {
		// X.Y Title
		reg = /(\d*)\.(\d*)\s(.*)/;
		res = reg.exec(description);

		if (res) {
			obj.desc = res[3];
		} else {
			// Lesson X: Title
			reg = /Lesson (.*):\s(.*)/;
			res = reg.exec(description);

			if (res) {
				obj.desc = res[2];
			} else {
				obj.desc = description;
			}
		}
	}

	return obj;
}

function callWhenComplete (options) {
	var returnDir = options.name + options.timestamp;
	var outputFile = "conversions/" + returnDir + ".zip";

	sendProgress(options.id, 100);

	options.response.json({"link": outputFile});
}

function addToUpdates (options, filename) {
	if (options.updates) {
		options.updates.push(filename);
	} else {
		options.updates = [filename];
	}
}

function ignoreTopLevelPath (fullpath) {
	var newpath = fullpath.split(path.sep);
	return newpath.slice(1).join(path.sep);
}

function escapeRegExp (string){
	var s = string.replace(/[.*+?^${}()|[/\]\\]/g, "\\$&");
	return s;
}

function doExtraction (options, callback) {
	console.log("extracting");

	var returnDir = options.name + options.timestamp;
	var targetDir = "temp/" + returnDir + "/";

	var stat = fs.statSync(options.path);
	var size = stat.size;
	console.log("Size = " + size);

	var processedLength = 0;

	fs.createReadStream(options.path)
		.on('close', function () {
		})
		.on('data', function (buffer) {
			processedLength += buffer.length;

			var pct = processedLength / size;

			sendProgress(options.id, pct * 80);
		})
		.pipe(unzip.Parse().on('close', callback))
		.on('entry', function (entry) {
			var fileName = entry.path;
			var type = entry.type;
			var size = entry.size;

			// convert filenames to lowercase and .xhtml to .html
			fileName = fileName.replace(".xhtml", ".html").toLowerCase();
			var fullPath = targetDir + fileName;
			var dir = path.dirname(fullPath);
			makeAllPaths(dir);
			var streamOut = fs.createWriteStream(fullPath);

			// chance to process each file
			// adding to full-text search index
			// and look for content marked with "rr-update" [kind of crude]
			entry.on('data', function (buffer) {
				if (fullPath.indexOf("s9ml/") != -1 && fullPath.indexOf(".html") != -1) {
					var data = buffer.toString("utf8");
					if (data.indexOf("rr-update") != -1) {
						var path_to_updated_file = ignoreTopLevelPath(fileName);
						addToUpdates(options, path_to_updated_file);
					}

					/*
					var $ = cheerio.load(data);
					var bodyText = $("body").text();
					var title = $("title").text();

					var doc = {
						"title": title,
						"body": bodyText,
						"id": fileName
					};

					options.idx.add(doc);
					*/
				}
			});

			// internal HTML conversions:
			if (fullPath.indexOf(".html") != -1) {
				// replace video http:// kludge with relative link
				entry.pipe(es.replace("<source type=\"video/mp4\" src=\"http://informit.com/", "<source type=\"video/mp4\" src=\""))
					.pipe(es.replace("<source type=\"video/webm\" src=\"http://informit.com/", "<source type=\"video/webm\" src=\""))
					.pipe(streamOut);
			} else {
				entry.pipe(streamOut);
			}
		});
}

function processTOC (options) {
	console.log("processing TOC");

	console.log("updates = " + (options.updates ? options.updates.length : 0));

	var returnDir = options.name + options.timestamp;
	var targetDir = "temp/" + returnDir + "/";

	var toc = fs.readFileSync(targetDir + "ops/toc.html", {encoding: "UTF-8"});

	toc = toc.replace(/.xhtml/g, ".html");

	var $ = cheerio.load(toc);

	if (options.updates) {
		for (var i = 0; i < options.updates.length; i++) {
			var update = escapeRegExp(options.updates[i]);
			var link = $("a[href*=" + update + "]");
			link.each(function (index, element) {
				$(element).addClass("rr-updated");
				console.log("updated " + $(element).html());
			});
		}
	}

	// TODO: walk through TOC and add text between hashtags to the search index, using the section index as the ref
	breakTOCIntoSections(options, $);

	fs.writeFileSync(targetDir + "ops/toc.html", $.html(), { encoding: "UTF-8", flag: "w" });

	sendProgress(options.id, 90);
}

function includeViewer (archive, options) {
	archive.file("public/viewer.html", { name: "/viewer.html" });
	archive.file("public/viewer.js", { name: "/viewer.js" });

	var settings = {
		title: options.title,
		folder: "epub",
		type: "habitat",
		skin: options.skin,
		infinite_scrolling: false
	};

	var settings_string = JSON.stringify(settings);

	var manifest = "define([], function () { return " + settings_string + "; });";

	archive.append(manifest, { name: "/manifest.js" });
}

function includeSearch (archive, options) {
	var search_index = JSON.stringify(options.idx.toJSON());
	var search_module = "define([], function () { return " + search_index + "; });";

	archive.append(search_module, { name: "/search_index.js" });
}

function writeZip (options) {
	console.log("writing zip");

	var returnDir = options.name + options.timestamp;
	var targetDir = "temp/" + returnDir + "/";

	var outputFile = "conversions/" + returnDir + ".zip";
	var outputPath = "public/" + outputFile;

	var dir = path.dirname(outputPath);
	makeAllPaths(dir);

	var outputStream = fs.createWriteStream(outputPath);
	var archive = archiver('zip');
	outputStream.on("close", function () {
		doCleanup(options, outputStream);

		// send completion response
		options.response.json({"link": outputFile});
	});
	archive.pipe(outputStream);
	archive.directory(targetDir, "/epub/");

	includeViewer(archive, options);
	includeSearch(archive, options);

	archive.finalize();

	sendProgress(options.id, 100);
}

function doCleanup (options, outputStream) {
	console.log("cleaning up");

	var returnDir = options.name + options.timestamp;
	var targetDir = "temp/" + returnDir + "/";

	outputStream.close();
	fs.unlinkSync(options.path);
	deleteFolderRecursive(targetDir);
}

function getFilenameWithoutHash (filename) {
	var h = filename.indexOf("#");
	if (h != -1) return filename.substr(0, h);
	else return filename;
}

function getHash (filename) {
	var h = filename.indexOf("#");
	if (h != -1) return filename.substr(h + 1);
	else return "";
}

function breakTOCIntoSections (options, $) {
	var sections = $("a");

	var lastHref = undefined, lastFilename = undefined, lastHash = undefined, lastTitle = undefined;

	for (var i = 0; i < sections.length; i++) {
		var thisSection = $(sections[i]);
		var nextSection = (i < sections.length - 1) ? $(sections[i + 1]) : undefined;

		var href = thisSection.attr("href");
		var filename = getFilenameWithoutHash(href);
		var hash = getHash(href);
		var title = thisSection.text();

		if (filename != lastFilename) {
			if (lastHash) {
				console.log("last file, lastHash to end of file");
				// last file, lastHash to end of file
				addToSearchIndex(options, { filename: lastFilename, start: lastHash, end: "", title: lastTitle, index: i - 1 } );
			} else {
				if (lastFilename) {
					console.log("last file, entire");
					// last file, entire
				}
			}
		} else {
			if (lastHash) {
				if (hash) {
					console.log("this file, lastHash to hash");
					// this file, lastHash to hash
					addToSearchIndex(options, { filename: filename, start: lastHash, end: hash, title: lastTitle, index: i - 1 } );
				} else {
					console.log("this file, lastHash to end of file");
					// this file, lastHash to end of file
				}
			} else {
				if (hash) {
					console.log("this file, start of file to hash");
					// this file, start of file to hash
					addToSearchIndex(options, { filename: filename, start: "", end: hash, title: lastTitle, index: i - 1 } );
				} else {
					// this file, no hash or lasthash; ignore [shouldn't happen]
				}
			}
		}

		lastHref = href;
		lastFilename = filename;
		lastHash = hash;
		lastTitle = title;
	}

	// add the last section
	addToSearchIndex(options, { filename: lastFilename, start: lastHash, end: "", title: lastTitle, index: sections.length - 1 } );
}

function getTextBetween ($, start, end) {
	var thisText = "";
	var started = false, finished = false;

	var target = $("#" + start);

	if (target[0].tagName == "html") {
		started = true;
	}

	var all = $("body").children();
	all.each(function (index, element) {
		var id = $(this).attr("id");
		if (id == start) {
			started = true;
		} else if (id == end) {
			finished = true;
		}
		if (started) {
			thisText += $(this).text();
		}
		if (finished) {
			return false;
		}
	});

	return thisText;
}

function addToSearchIndex (options, params) {
	var returnDir = options.name + options.timestamp;
	var targetDir = "temp/" + returnDir + "/";

	var data = fs.readFileSync(targetDir + "ops/" + params.filename);

	var $ = cheerio.load(data);

	var start, end, thisText = "";

	console.log(params.start + " : " + params.end);

	if (params.start && params.end) {
		thisText = getTextBetween($, params.start, params.end);
	} else if (params.start && !params.end) {
		// read from start to end of file
		thisText = getTextBetween($, params.start, params.end);
	} else if (!params.start && params.end) {
		var end = $("#" + params.end);

		if (end[0].tagName == "html") {
			// nothing to read
			console.log("skipping");
			return;
		}

		// walk until we find this id
		var all = $("body").children();
		all.each(function (index, element) {
			var id = $(this).attr("id");
			console.log(id + " / " + params.end);
			if (id == params.end) {
				console.log("Found it");
			}
		});
	}

	if (thisText) {
		console.log("added " + thisText.length);

		var doc = {
			"title": params.title,
			"body": thisText,
			"id": params.index
		};

		options.idx.add(doc);
	} else {
		console.log("nothing for " + params.start + " to " + params.end);
	}
}
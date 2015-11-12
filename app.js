var fs = require('fs');
var archiver = require('archiver');
var express = require('express');
var multer = require('multer');
var unzip = require('unzip');
var path = require('path');
var cheerio = require('cheerio');
var es = require('event-stream');
var parse = require('csv-parse');
var Datauri = require('datauri');

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

		var posterFile;
		if (request.files.posterFile) {
			posterFile = request.files.posterFile.path;
		}

		//console.log(request.body); // form fields
		//console.log(request.files); // form files

		var converted = doConversion({
			name: request.files.file.originalname,
			path: request.files.file.path,
			posterFile: posterFile,
			response: response,
			id: request.body.requestid,
			title: request.body.title,
			mediaPath: request.body.path == undefined ? "" : request.body.path,
			zipfiles: request.body.zipfiles,
			courseZipfile: request.body.courseZipfile,
			isbn: request.body.isbn
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
	var parseOptions = { delimiter: "\t", quote: "" };

	parse(input, parseOptions, function(err, output) {
		if (!err) {
			processData(options, output);

			callWhenComplete(options);
		} else {
			console.log("error");
			console.log(err);
		}
	});
}

function processPosterImage (options) {
	if (options.posterFile) {
		var imageURI = new Datauri(options.posterFile);
		options.posterImageData = imageURI.content;
	}
}

function processData (options, data) {
	var toc = [];
	var lastPart = -1, lastLesson = -1, lastSublesson = -1, lastSubsublesson = -1, lastDepth = undefined;
	var last = [undefined, undefined, undefined, undefined];
	var counters = [-1, -1, -1, -1];

	for (var i = 0; i < data.length; i++) {
		var row = data[i];
		var obj = {};

		var parsed = {
			part: row[0],
			lesson: row[1],
			sublesson: row[2],
			subsublesson: row[3],
			short: row[4],
			filename: row[5],
			duration: row[7]
		};

		var description = parsed.part;
		if (description == "") description = parsed.lesson;
		if (description == "") description = parsed.sublesson;
		if (description == "") description = parsed.subsublesson;

		parsed.description = description;

		obj.video = parsed.filename;

		var duration = parsed.duration;
		if (duration) {
			obj.isVideo = true;
			obj.duration = duration;
		} else {
			obj.isVideo = false;
		}

		var info = parseInfoFromText(parsed);

		parseDepthsFromFields(obj, info, last, counters);

		obj.short = info.short;
		obj.desc = info.desc;

		if (obj.desc == "Learning Objectives") {
			obj.short = obj.lesson + ".0";
		}

		var curDepth = [];

		curDepth.push(obj.part);
		curDepth.push(obj.lesson);
		curDepth.push(obj.sublesson);
		curDepth.push(obj.subsublesson);

		obj.depth = "";

		for (var j = 0; j < curDepth.length; j++) {
			if (curDepth[j] != -1 && curDepth[j] != undefined) {
				if (obj.depth != "") obj.depth += ",";
				obj.depth += curDepth[j];
			}
		}

		lastPart = obj.part;
		lastLesson = obj.lesson;
		lastSublesson = obj.sublesson;
		lastSubsublesson = obj.subsublesson;
		lastInfoLesson = info.lesson;
		lastDepth = curDepth;

		toc.push(obj);
	}

	options.toc = toc;

	processPosterImage(options);

	options.lastPart = lastPart;
	options.lastLesson = lastLesson;
	options.lastSublesson = lastSublesson;
	options.lastDepth = lastDepth;

	generateJavascriptTOC(options);

	writeZip(options);
}

function parseDepthsFromFields (obj, info, last, counters) {
	if (info.part != "" && info.part != last.part) {
		counters[0] = counters[0] + 1;
		counters[1] = counters[2] = counters[3] = -1;
		obj.part = counters[0];
		last.part = info.part;
	} else if (info.lesson != "" && info.lesson != last.lesson) {
		counters[1] = counters[1] + 1;
		counters[2] = counters[3] = -1;
		obj.lesson = counters[1];
		last.lesson = info.lesson;
	} else if (info.sublesson != "" && info.sublesson != last.sublesson) {
		counters[2] = counters[2] + 1;
		counters[3] = -1;
		obj.sublesson = counters[2];
		last.sublesson = info.sublesson;
	} else if (info.subsublesson != "" && info.subsublesson != last.subsublesson) {
		counters[3] = counters[3] + 1;
		obj.subsublesson = counters[3];
		last.subsublesson = info.sublesson;
	}

	if (counters[0] != -1)
		obj.part = counters[0];

	if (counters[1] != -1)
		obj.lesson = counters[1];

	if (counters[2] != -1)
		obj.sublesson = counters[2];

	if (counters[3] != -1)
		obj.subsublesson = counters[3];
}

function generateJavascriptTOC (options) {
	var s = "define([], function () {\n\
	var toc = [\n";

	var lastTopLevel = undefined;
	if (options.lastDepth) {
		lastTopLevel = parseInt(options.lastDepth[0]);
	}

	for (var i = 0; i < options.toc.length; i++) {
		var entry = options.toc[i];

		var obj = { depth: entry.depth, short: entry.short, desc: entry.desc, duration: entry.duration };

		if (options.zipfiles) {
			/*
			// THEORY: lessons between 1 and n-1 get zipfile links
			var lessonNumber = parseInt(entry.lesson);
			if (lessonNumber > 0 && lessonNumber < options.lastLesson && (entry.sublesson === "" || entry.sublesson === undefined)) {
				var lessondigits = parseInt(entry.lesson);
				if (lessondigits < 10) lessondigits = "0" + lessondigits;
				obj.download = path.join(options.mediaPath, options.isbn + "-lesson_" + lessondigits + ".zip");
			}
			*/
			// NEW THEORY: top-level depths get zipfile links
			var depths = entry.depth.split(",");
			if (depths.length == 1) {
				var d = parseInt(depths[0]);
				if (d > 0 && d < lastTopLevel) {
					if (d < 10) d = "0" + d;
					obj.download = path.join(options.mediaPath, options.isbn + "-lesson_" + d + ".zip");
				}
			}
		}

		if (entry.isVideo) {
			obj.video = path.join(options.mediaPath, entry.video.toLowerCase());
		} else if (entry.video) {
			if (entry.video.toLowerCase().indexOf(".html") != -1) {
				obj.src = entry.video;
			} else {
				obj.video = entry.video;
			}
		}

		s += JSON.stringify(obj);

		if (i < options.toc.length - 1) {
			s += ",";
		}

		s += "\n";
	}

	s += "];\n";

	s += "var projectTitle = " + JSON.stringify(options.title) + ";\n";

	if (options.courseZipfile) {
		var n = path.join(options.mediaPath, options.isbn + "-lessons.zip");
		s += "var zipFile = " + JSON.stringify(n) + ";\n";
	} else {
		s += "var zipFile = undefined;\n";
	}

	if (options.posterImageData) {
		s += "var posterImageData = " + JSON.stringify(options.posterImageData) + ";\n";
	} else {
		s += "var posterImageData = undefined;\n";
	}

	s += "return { toc: toc, markers: [], title: projectTitle, posterImage: posterImageData, zipFile: zipFile }\n\
});";

	options.tocJS = s;
}

function parseInfoFromText (params) {
	var obj = { part: params.part, lesson: params.lesson, sublesson: params.sublesson, subsublesson: params.subsublesson, short: "", desc: params.description };

	var found = false;

	if (!found) {
		// look for: "Lesson _: Title" in filename
		reg = /^lesson (.*):\s(.*)/i;
		res = reg.exec(params.filename);

		if (res) {
			obj.short = res[1];
			found = true;
		}
	}

	if (!found) {
		// X.Y Title in description
		reg = /^(\d{1,2})\.(\d{1,2})\s(.*)/;
		res = reg.exec(params.description);

		if (res) {
			obj.short = res[1] + "." + res[2];
			obj.desc = res[3];
			found = true;
		}
	}

	return obj;
}

function callWhenComplete (options) {
	sendProgress(options.id, 100);

	options.response.json({"link": options.outputFile});
}

function writeZip (options) {
	var returnDir = options.name + options.timestamp;
	var targetDir = path.join("temp", returnDir, "output");

	var outputFile = "conversions/" + returnDir + ".zip";
	var outputPath = "public/" + outputFile;

	var dir = path.dirname(outputPath);
	makeAllPaths(dir);

	var folder = options.title;

	var outputStream = fs.createWriteStream(outputPath);
	var archive = archiver('zip');

	outputStream.on("close", function () {
		doOnDone(options, outputStream);
	});

	archive.pipe(outputStream);

	archive.append(options.tocJS, { name: "/toc.js"});

	includeViewer(archive, options);
//	includeSearch(archive, options);

	archive.finalize();

	options.outputFile = outputFile;
}

function doOnDone (options, outputStream) {
	if (outputStream) {
		doCleanup(options, outputStream);
	}
}

function doCleanup (options, outputStream) {
	console.log("cleaning up");

	var returnDir = options.name + options.timestamp;
	var targetDir = "temp/" + returnDir + "/";

	outputStream.close();
	fs.unlinkSync(options.path);
	deleteFolderRecursive(targetDir);

	console.log("done");
}

function includeViewer (archive, options) {
	archive.file("public/runcourse.html", { name: "/runcourse.html" });
	archive.file("public/viewer.js", { name: "/viewer.js" });

	var settings = {
		title: options.title,
		type: "metadata",
		infinite_scrolling: false
	};

	var settings_string = JSON.stringify(settings);

	var manifest = "define([], function () { return " + settings_string + "; });";

	archive.append(manifest, { name: "/manifest.js" });
}

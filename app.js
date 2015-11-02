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
}

function processPosterImage (options) {
	if (options.posterFile) {
		var imageURI = new Datauri(options.posterFile);
		options.posterImageData = imageURI.content;
	}
}

// part, lesson, sublesson

function processData (options, data) {
	var toc = [];

	var counter = 0;

	var curPart = 0, lastPart = undefined, lastLesson = undefined, lastSublesson = 0;
	var lastInfoLesson;
	var depth = undefined;


	for (var i = 0; i < data.length; i++) {
		var row = data[i];
		var obj = {};

		obj.video = row[0];

		var duration = row[2];
		if (duration) {
			obj.isVideo = true;
			obj.duration = duration;
		} else {
			// NOTE: this is a "heading" [which might be a better way of detecting the hierarchy]
			obj.isVideo = false;
		}

		var info = parseInfoFromText(row[0], row[1]);

		obj.short = info.short;
		obj.desc = info.desc;
		obj.part = info.part;
		obj.lesson = info.lesson;
		obj.sublesson = info.sublesson;

		var curDepth = "";

		if (obj.lesson == "Introduction") {
			obj.lesson = "0";
		} else if (obj.lesson == "Summary") {
			obj.lesson = parseInt(lastLesson) + 1;
		}

		if (obj.part === undefined) {
			obj.part = lastPart;
		}

		if (obj.lesson === undefined) {
			obj.lesson = lastLesson;
		}

		if (obj.sublesson === undefined) {
			if (lastSublesson != undefined) {
				if (lastSublesson == "")
					obj.sublesson = "0";
				else
					obj.sublesson = parseInt(lastSublesson) + 1;
			} else {
				obj.sublesson = counter++;
			}
		}

		if (obj.part != undefined) curDepth = obj.part;

		if (obj.lesson != undefined && obj.lesson !== "") {
			if (curDepth !== "") curDepth += ",";
			curDepth += obj.lesson;
		}
		if (obj.sublesson != undefined && obj.sublesson !== "") {
			if (curDepth !== "") curDepth += ",";
			curDepth += obj.sublesson;
		}

		if (obj.lesson !== lastLesson) {
			counter = 0;
		}

		obj.depth = curDepth;

		// THEORY: First and "Summary" sections don't get short labels (could also use "first and last lessons don't get short labels")
		if (obj.lesson > 0) {
			if (lastInfoLesson != "Summary") {
				obj.short = obj.lesson + "." + obj.sublesson;
			} else {
				obj.short = "";
			}
		} else {
			obj.short = "";
		}

		lastPart = obj.part;
		lastLesson = obj.lesson;
		lastSublesson = obj.sublesson;
		lastInfoLesson = info.lesson;

		toc.push(obj);
	}

	options.toc = toc;

	processPosterImage(options);

	options.lastPart = lastPart;
	options.lastLesson = lastLesson;
	options.lastSublesson = lastSublesson;

	generateJavascriptTOC(options);

	writeZip(options);
}

function generateJavascriptTOC (options) {
	var s = "define([], function () {\n\
	var toc = [\n";

	for (var i = 0; i < options.toc.length; i++) {
		var entry = options.toc[i];

		var obj = { depth: entry.depth, short: entry.short, desc: entry.desc, duration: entry.duration };

		if (options.zipfiles) {
			var lessonNumber = parseInt(entry.lesson);
			// THEORY: lessons between 1 and n-1 get zipfile links
			if (lessonNumber > 0 && lessonNumber < options.lastLesson && (entry.sublesson === "" || entry.sublesson === undefined)) {
				var lessondigits = parseInt(entry.lesson);
				if (lessondigits < 10) lessondigits = "0" + lessondigits;
				obj.download = path.join(options.mediaPath, options.isbn + "-lesson_" + lessondigits + ".zip");
			}
		}

		if (entry.isVideo) {
			obj.video = path.join(options.mediaPath, entry.video.toLowerCase());
		}

		s += JSON.stringify(obj);

		if (i < options.toc.length - 1) {
			s += ",";
		}

		s += "\n";
	}

	s += "];\n";

	s += "var projectTitle = " + JSON.stringify(options.title) + ";\n";

	if (options.zipfiles) {
		var n = path.join(options.mediaPath, options.isbn + "-lessons.zip");
		s += "var zipFile = " + JSON.stringify(n) + ";\n";
	}

	if (options.posterImageData) {
		s += "var posterImageData = " + JSON.stringify(options.posterImageData) + ";\n";
	} else {
		s += "var posterImageData = undefined;\n";
	}

	s += "return { toc: toc, markers: [], title: projectTitle, posterImage: posterImageData, zipFile: zipFile }\n\
});";

	options.tocJS = s;

	/*
	var returnDir = options.name + options.timestamp;

	var outputFile = "conversions/" + returnDir + "_toc.js";
	var outputPath = "public/" + outputFile;

	var dir = path.dirname(outputPath);
	makeAllPaths(dir);

	options.outputFile = outputFile;

	fs.writeFileSync(outputPath, s);
	*/
}

function parseInfoFromText (filename, description) {
	var obj = { part: undefined, lesson: undefined, sublesson: undefined, short: "", desc: "" };

	var reg, res;

	var found = false;

	// look for: "Introduction" in filename
	reg = /^introduction/i;
	res = reg.exec(filename);

	if (res) {
		obj.lesson = "Introduction";
		obj.sublesson = "";
		obj.desc = description;
		obj.short = "";
		found = true;
	}

	if (!found) {
		// look for: "Summary" in filename
		reg = /^summary/i;
		res = reg.exec(filename);

		if (res) {
			obj.lesson = "Summary";
			obj.sublesson = "";
			obj.desc = description;
			found = true;
		}
	}

	if (!found) {
		// look for: "Lesson _: Title" in filename
		reg = /^lesson (.*):\s(.*)/i;
		res = reg.exec(filename);

		if (res) {
			obj.lesson = res[1];
			obj.sublesson = "";
			obj.desc = res[0];
			obj.short = res[1];
			found = true;
		}
	}

	if (!found) {
		// look for XX_YY in filename
		reg = /^(\d*)\_(\d*)/;
		res = reg.exec(filename);

		if (res) {
			obj.lesson = parseInt(res[1]);
			if (res[2])
				obj.sublesson = parseInt(res[2]);

			// X.Y Title
			reg = /(\d*)\.(\d*)\s(.*)/;
			desc_res = reg.exec(description);

			if (desc_res) {
				obj.desc = desc_res[3];
				obj.short = desc_res[1] + "." + desc_res[2];
			} else {
				// if no X.Y Title, use the XX_YY from the the filename
				obj.desc = description;
				var lesson = parseInt(res[1]);
				var sublesson = parseInt(res[2]);
				if (!isNaN(lesson) && !isNaN(sublesson))
					obj.short = lesson + "." + sublesson;
			}

			found = true;
		}
	}

	if (!found) {
		// look for ISBN-XX_YY in filename
		reg = /^(\d*)-(\d*)\_(\d*)/;
		res = reg.exec(filename);

		if (res) {
			obj.lesson = parseInt(res[2]);
			if (res[2])
				obj.sublesson = parseInt(res[3]);

			// X.Y Title in description
			reg = /(\d*)\.(\d*)\s(.*)/;
			desc_res = reg.exec(description);

			if (desc_res) {
				obj.desc = desc_res[3];
				obj.short = desc_res[1] + "." + desc_res[2];
			} else {
				// if no X.Y Title, use the XX_YY from the the filename
				obj.desc = description;
				var lesson = parseInt(res[2]);
				var sublesson = parseInt(res[3]);
				if (!isNaN(lesson) && !isNaN(sublesson))
					obj.short = lesson + "." + sublesson;
			}

			found = true;
		}
	}

	return obj;
}

// Dan's latest TOC doesn't match this anymore (!)
function parseInfoFromText_deprecated (filename, description) {
	var obj = { part: "", short: "", desc: "", major: "" };

	var reg, res;

	// Part X: Part title
	reg = /^part (.*):\s(.*)/i;
	res = reg.exec(filename);

	if (res) {
		obj.short = res[1];
		obj.part = res[1];
		obj.major = "";
	} else {
		// Lesson X: Lesson title
		reg = /^lesson (.*):\s(.*)/i;
		res = reg.exec(filename);

		if (res) {
			obj.short = res[1];
			obj.major = res[1];
		} else {
			// Lesson_X_Y
			reg = /^lesson_(.*)_(.*)/i;
			res = reg.exec(filename);

			if (res) {
				obj.short = res[1] + "." + res[2];
				obj.major = res[1];
			} else {
				// Summary
				reg = /^summary/i;
				res = reg.exec(filename);

				if (res) {
					obj.part = "Summary";
				}
			}
		}
	}

	// Part X: Part title
	reg = /Part (.*):\s(.*)/;
	res = reg.exec(description);

	if (res) {
		obj.desc = res[0];
	} else {
		// X.Y Title
		reg = /(\d*)\.(\d*)\s(.*)/;
		res = reg.exec(description);

		if (res) {
			obj.major = res[1];
			obj.part = res[2];
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

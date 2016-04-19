var fs = require('fs');
var archiver = require('archiver');
var express = require('express');
var multer = require('multer');
var path = require('path');
var cheerio = require('cheerio');
var es = require('event-stream');
var parse = require('csv-parse');
var Datauri = require('datauri');
var lunr = require('lunr');
var yauzl = require("yauzl");

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

		var transcriptFile;
		if (request.files.transcript_zip) {
			transcriptFile = request.files.transcript_zip.path;
		}

		//console.log(request.body); // form fields
		//console.log(request.files); // form files

		var converted = doConversion({
			name: request.files.file.originalname,
			path: request.files.file.path,
			transcript_path: transcriptFile,
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

	options.idx = lunr(function () {
		this.field('title');
		this.field('body');
	});

	var input = fs.readFileSync(options.path, "utf8");
	var parseOptions = { delimiter: "\t", quote: "" };

	parse(input, parseOptions, function(err, output) {
		if (!err) {
			processData(options, output);

			if (options.transcriptPath)
				processTranscript(options);
			else
				doneWithTranscript(options);
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
			short: row[2],
			sublesson: row[3],
			subsublesson: row[4],
			filename: row[5],
			duration: row[6]
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
		for (var i = 0; i < options.lastDepth.length; i++) {
			if (options.lastDepth[i] != undefined) {
				lastTopLevel = parseInt(options.lastDepth[i]);
				break;
			}
		}
	}

	for (var i = 0; i < options.toc.length; i++) {
		var entry = options.toc[i];

		var obj = { depth: entry.depth, short: entry.short, desc: entry.desc, duration: entry.duration };

		if (entry.captions) obj.captions = entry.captions;
		if (entry.transcript) obj.transcript = entry.transcript;

		// add this TOC entry to the search index
		var doc = {
			"title": entry.desc,
			"id": i
		};

		options.idx.add(doc);

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
			var count = 0;
			var first_level = undefined;
			for (var j = 0; j < depths.length; j++) {
				if (depths[j] != undefined) {
					count++;
					if (first_level == undefined) first_level = depths[j];
				}
			}
			if (count == 1) {
				var d = parseInt(first_level);
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
	var obj = { part: params.part, lesson: params.lesson, sublesson: params.sublesson, subsublesson: params.subsublesson, short: params.short, desc: params.description };

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

function streamToString (stream, cb) {
	var chunks = [];
	stream.on('data', function (chunk) {
		chunks.push(chunk);
	});

	stream.on('end', function () {
		cb(chunks.join(''));
	});
}

function processTranscript (options) {
	var returnDir = options.name + options.timestamp;
	var targetDir = "temp/" + returnDir + "/";

	// unzip transcript zip
	// convert srt to vtt
	// associate videos with transcript files
	// add transcript (vtt or dbxf) to lunr search index
	// zip up vtt, dbxf, and search index

	yauzl.open(options.transcript_path, function (err, zipfile) {
		if (err) throw err;

		zipfile.on("close", function () {
			doneWithTranscript(options);
		});

		zipfile.on("entry", function (entry) {
			if (/\/$/.test(entry.fileName)) {
				// directory file names end with '/'
				return;
			}

			zipfile.openReadStream(entry, function (err, readStream) {
				if (err) throw err;

				readStream.setEncoding('utf8');

				// process the srt files
				if (entry.fileName.indexOf(".srt") != -1) {
					// THEORY: find the toc video file that most closely matches this srt file
					var tocReference = findTOCReference(options.toc, entry.fileName);

					var newFilename = entry.fileName.replace(".srt", ".vtt");

					streamToString(readStream, function (s) {
						var writePath = path.join(targetDir + "/media/vtt/", newFilename);
						var filePath = path.dirname(writePath);
						makeAllPaths(filePath);

						s = s.replace(/\r/g, "");

						var searchableText = "";

						var output = "WEBVTT\n\n";

						var lines = s.split("\n");
						var count = 0;
						for (var i = 0; i < lines.length; i++) {
							var line = lines[i];
							if (line == "") count = 0;
							else count++;

							if (count == 2) {
								// replace commas in timing lines with periods
								line = line.replace(/,/g, ".");
								// add line position to move the cue up a little (CSS was ineffective)
								line += " line:80%";
							} else if (count > 2) {
								searchableText += line;
							}

							output += line + "\n";
						}

						output = output.trim();

						fs.writeFileSync(writePath, output, {encoding: "UTF-8", flag: "w"});

						if (tocReference) {
							var doc = {
								"title": tocReference.title,
								"body": searchableText,
								"id": tocReference.index
							};

							options.toc[tocReference.index].captions = "media/vtt/" + newFilename;

							var transcriptFilename = path.basename(newFilename, path.extname(newFilename)) + ".dfxp";
							options.toc[tocReference.index].transcript = "media/transcript/" + transcriptFilename;

							options.idx.add(doc);
						}
					});
				} else if (entry.fileName.indexOf(".dfxp") != -1) {
					var writePath = path.join(targetDir + "/media/transcript/", entry.fileName);

					// ensure parent directory exists
					var filePath = path.dirname(writePath);
					makeAllPaths(filePath);

					// write file
					readStream.pipe(fs.createWriteStream(writePath));
				}
			});
		});
	});
}

function findTOCReference (toc, filename) {
	var file = path.basename(filename, path.extname(filename));
	// assuming the transcript file is in this format: 9780789756350-02_04_01.vtt
	var dash = file.indexOf("-");
	if (dash != -1) {
		file = file.substr(dash + 1);
	}

	if (file) {
		for (var i = 0; i < toc.length; i++) {
			var entry = toc[i];
			if (entry.video && entry.video.indexOf(file) != -1) {
				return {
					title: entry.desc,
					index: i
				}
			}
		}
	}

	return undefined;
}

function includeSearch (archive, options) {
	var search_index = JSON.stringify(options.idx.toJSON());
	var search_module = "define([], function () { return " + search_index + "; });";

	archive.append(search_module, { name: "/search_index.js" });
}

function includeTranscriptFolders (archive, options) {
	var returnDir = options.name + options.timestamp;
	var targetDir = "temp/" + returnDir + "/";

	makeAllPaths(targetDir + "media/vtt/");
	archive.directory(targetDir + "media/vtt/", "/media/vtt/");
	makeAllPaths(targetDir + "media/transcript/");
	archive.directory(targetDir + "media/transcript/", "/media/transcript/");
}

function doneWithTranscript (options) {
	generateJavascriptTOC(options);

	writeZip(options);
}

function completelyDone (options) {
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
		doneWithZip(options, outputStream);
	});

	archive.pipe(outputStream);

	archive.append(options.tocJS, { name: "/toc.js"});

	includeViewer(archive, options);
	includeSearch(archive, options);
	includeTranscriptFolders(archive, options);

	archive.finalize();

	options.outputFile = outputFile;
}

function doneWithZip (options, outputStream) {
	if (outputStream) {
		doCleanup(options, outputStream);
	}

	completelyDone(options);
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

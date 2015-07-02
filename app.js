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
			mediaPath: request.body.path
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

function processData (options, data) {
	var toc = [];

	var curPart = 0, lastPart = undefined, depth = undefined, lastMajor = undefined, minor = 0;

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
		obj.major = info.major;
		obj.part = info.part;

		var curDepth = undefined;

		if (obj.part && obj.part != lastPart) {
			curPart++;
			depth = 0;

			lastPart = obj.part;

			curDepth = curPart;
		}

		if (curDepth == undefined) {
			if (obj.major == "") {
				if (depth == undefined)
					depth = 0;
				else
					depth++;

				if (obj.major == "" && toc.length > 0 && obj.desc == toc[toc.length - 1].desc) {
					depth--;
					curDepth = curPart + "," + depth + "," + (minor++);
				} else {
					minor = 0;

					curDepth = curPart + "," + depth;
				}
			} else if (obj.major == lastMajor) {
				curDepth = curPart + "," + depth + "," + minor;

				minor++;
			} else {
				depth++;
				minor = 0;

				curDepth = curPart + "," + depth;
			}
		}

		obj.depth = curDepth;

		lastMajor = obj.major;

		toc.push(obj);
	}

	options.toc = toc;

	processPosterImage(options);

	writeJavascriptOutput(options);
}

function writeJavascriptOutput (options) {
	var s = "define([], function () {\n\
	var toc = [\n";

	for (var i = 0; i < options.toc.length; i++) {
		var entry = options.toc[i];

		var obj = { depth: entry.depth, short: entry.short, desc: entry.desc, duration: entry.duration };

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

	s += "projectTitle = " + JSON.stringify(options.title) + ";\n";

	if (options.posterImageData) {
		s += "posterImageData = " + JSON.stringify(options.posterImageData) + ";\n";
	}

	s += "return { toc: toc, markers: [], title: projectTitle, posterImage: posterImageData }\n\
});";

	var returnDir = options.name + options.timestamp;

	var outputFile = "conversions/" + returnDir + "_toc.js";
	var outputPath = "public/" + outputFile;

	var dir = path.dirname(outputPath);
	makeAllPaths(dir);

	options.outputFile = outputFile;

	fs.writeFileSync(outputPath, s);
}

function parseInfoFromText (filename, description) {
	var obj = { part: "", short: "", desc: "", major: "" };

	var reg, res;

	// Part X: Part title
	reg = /Part (.*):\s(.*)/;
	res = reg.exec(filename);

	if (res) {
		obj.short = res[1];
		obj.part = res[1];
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
			} else {
				// Summary
				reg = /Summary/;
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
'use strict';

console.log('dev-lambda');

var _ = require('lodash');
var app = require('express')();
var bodyParser = require('body-parser');
var childProcess = require('child_process');
var fs = require('fs');
var nodefn = require('when/node');
var path = require('path');
var when = require('when');

var lambdaBaseDir = process.argv[2] || process.env.LAMBDA_BASE_DIR || path.resolve(__dirname, '..', 'lambdas');
var defaultHandler = process.env.LAMBDA_DEFAULT_HANDLER || 'index.handler';
var defaultMaxMemory = parseInt(process.env.LAMBDA_DEFAULT_MAX_MEMORY) || 128;
var defaultTimeout = parseInt(process.env.LAMBDA_DEFAULT_TIMEOUT) || 3;
var maxHistorySize = parseInt(process.env.LAMBDA_MAX_HISTORY) || 10;
var listenPort = parseInt(process.env.LAMBDA_PORT) || 8080;

app.use(bodyParser.json());

var lambdaConfigMap = {};
var historyMap = {};
var metricsMap = {};

function loadLambdaBaseDir(baseDirPath) {
	return when()
		.then(function () {
			// remove lambdas that don't exist anymore
			var removeKeys = [];
			var lNameList = _.keys(lambdaConfigMap);
			
			return when.filter(lNameList, function (lName) {
				var dirPath = lambdaConfigMap[lName].dirPath;
				
				return nodefn.lift(fs.stat).bind(fs)(dirPath).then(function (stat) {
					// path doesn't exist or isn't a directory
					return !stat || !stat.isDirectory();
				});
			}).then(function (lName) {
				// ok remove the dead lambda
				delete lambdaConfigMap[lName];
			});
		})
		.then(function () {
			// get a list of the contents of lambdas base dir
			return nodefn.lift(fs.readdir).bind(fs)(baseDirPath);
		})
		.then(function (baseDirEntryList) {
			// filter down to just directories
			return when.filter(baseDirEntryList, function (baseDirEntry) {
				var entryPath = path.resolve(lambdaBaseDir, baseDirEntry);
				
				return nodefn.lift(fs.stat).bind(fs)(entryPath).then(function (stat) {
					return stat && stat.isDirectory();
				});
			})
		})
		.then(function (lNameList) {
			return when.map(lNameList, function (lName) {
				// set the source directory
				var dirPath = path.resolve(lambdaBaseDir, lName);
				
				var configFilePath = path.resolve(dirPath, 'config.json');
				
				var config;
				return nodefn.lift(fs.readFile).bind(fs)(configFilePath, 'utf8')
					.then(function (configFileContent) {
						config = JSON.parse(configFileContent);
					})
					.catch(function () {})
					.then(function () {
						lambdaConfigMap[lName] = {
							name: lName,
							dirPath: dirPath,
							handler: config && config.handler || defaultHandler,
							maxMemory: config && config.maxMemory || defaultMaxMemory,
							timeout: config && config.timeout || defaultTimeout
						};
					})
				;
			});
		})
	;
}

function getFormatedDate(date) {
	return date.getUTCFullYear() + '-'
		+ ('0' + (date.getUTCMonth() + 1)).substr(-2) + '-'
		+ ('0' + date.getUTCDate()).substr(-2) + ' '
		+ ('0' + date.getUTCHours()).substr(-2) + ':'
		+ ('0' + date.getUTCMinutes()).substr(-2) + ':'
		+ ('0' + date.getUTCSeconds()).substr(-2) + '.'
		+ ('00' + date.getUTCMilliseconds()).substr(-3)
	;
}

function spawnLambda(config, event) {
	return when.promise(function (resolve, reject) {
		var result, metrics, timeoutKill;
		
		var child = childProcess.spawn('node', [], {cwd: config.dirPath});
		// 128 MB + 1 bytes is minimal needed on MAC OSX for node to not
		// give "segmentation fault: 11". Then gives "Allocation failed -
		// process out of memory" until enough memory is allocated.
		// var maxMemoryInBytes = (128 + config.maxMemory) * 1024 * 1024;
		// var child = childProcess.spawn('node', ['--stack-size=' + maxMemoryInBytes], options);
		
		child.stdout.on('data', function (data) {
			var now = new Date();
			var ms = now.getTime();
			var formated = getFormatedDate(now);
			
			result.visible.updated = formated;
			result.visible.output = result.visible.output || [];
			result.visible.output.push(formated + ': ' + data.toString());
		});
		child.stderr.on('data', function (data) {
			var now = new Date();
			var ms = now.getTime();
			var formated = getFormatedDate(now);
			
			result.visible.updated = formated;
			result.visible.error = result.visible.error || [];
			result.visible.error.push(formated + ': ' + data.toString());
			result.visible.duration = ms - result.internal.started;
		});
		child.on('error', function (error) {
			var now = new Date();
			var ms = now.getTime();
			var formated = getFormatedDate(now);
			
			metrics.counts.error = (metrics.counts.error || 0) + 1;
			result.visible.status = 'error';
			result.visible.updated = formated;
			result.visible.error = result.visible.error || [];
			result.visible.error.push(formated + ': ' + error.toString());
			result.visible.duration = ms - result.internal.started;
		});
		child.on('close', function (code) {
			var now = new Date();
			var ms = now.getTime();
			var formated = getFormatedDate(now);
			
			metrics.counts.started--;
			if (result.visible.status === 'started') {
				metrics.counts.done = (metrics.counts.done || 0) + 1;
				result.visible.status = 'done';
			}
			result.visible.updated = formated;
			result.visible.completed = formated;
			result.visible.duration = ms - result.internal.started;
			
			metrics.averageDuration = (result.visible.duration + (metrics.averageDuration || 0) * (metrics.counts.total - 1)) / metrics.counts.total;
			
			clearTimeout(timeoutKill);
			resolve();
		});
		
		var filename = config.handler.split('.', 1)[0] + '.js';
		var exportHandler = config.handler.split('.', 2)[1];
		var loader = ""
			+ "'use strict';"
			+ "var event = " + JSON.stringify(event) + ";"
			+ "var context = {"
			+ "	succeed: function (data) {process.exit();},"
			+ "	fail: function (data) {process.exit(1);}"
			+ "};"
			+ "var lambda;"
			+ "try {"
			+ "	lambda = require(" + JSON.stringify('./' + filename) + ");"
			+ "} catch (error) {"
			+ "	if (error.code !== 'MODULE_NOT_FOUND') {"
			+ "		throw error;"
			+ "	}"
			+ "	console.error('a js file was not found that corresponds to the file component of the handler property in config.json: expected js file=" + JSON.stringify(filename) + "; lambda=" + JSON.stringify(config.name) + "');"
			+ "	process.exit(1);"
			+ "}"
			+ "if (typeof lambda[" + JSON.stringify(exportHandler) + "] !== 'function') {"
			+ "	console.error('the exports property specified by the handler property in config.json was not found in the lambda js file: exports property expected=" + JSON.stringify(exportHandler) + "; lambda js file=" + JSON.stringify(filename) + "; lambda=" + JSON.stringify(config.name) + "');"
			+ "	process.exit(1);"
			+ "}"
			+ "lambda[" + JSON.stringify(exportHandler) + "](event, context);"
		;
		child.stdin.setEncoding('utf-8');
		child.stdin.write(loader);
		child.stdin.end();
		
		timeoutKill = setTimeout(function () {
			metrics.counts.timeout = (metrics.counts.timeout || 0) + 1;
			result.visible.status = 'killed - timeout';
			child.kill();
		}, config.timeout * 1000);
		
		var now = new Date();
		result = {
			visible: {
				status: 'started',
				started: getFormatedDate(now)
			},
			internal: {
				started: now.getTime()
			}
		};
		
		historyMap[config.name] = historyMap[config.name] || [];
		metricsMap[config.name] = metricsMap[config.name] || {counts: {total: 0, started: 0}};
		
		var history = historyMap[config.name];
		history.unshift(result);
		if (history.length > maxHistorySize) {
			history.pop();
		}
		
		metrics = metricsMap[config.name];
		metrics.counts.total++;
		metrics.counts.started++;
	});
}

function getLambdaResponse(name) {
	var output = {};
	if (metricsMap[name]) {
		output.metrics = metricsMap[name];
	}
	if (historyMap[name]) {
		output.history = _.map(historyMap[name], function (cache) {
			return cache.visible;
		});
	}
	output.config = lambdaConfigMap[name];
	return output;
}

loadLambdaBaseDir(lambdaBaseDir).then(function () {
	console.log('serving lambdas');
	
	app.get('/', function(req, res) {
		console.log('GET /');
		var output = {};
		_.forOwn(lambdaConfigMap, function (config, name) {
			output[name] = getLambdaResponse(name);
		});
		res.send(output);
	});
	
	_.forOwn(lambdaConfigMap, function (config, name) {
		app.get('/' + config.name, function (req, res) {
			console.log('GET /' + config.name);
			res.send(getLambdaResponse(name));
		});
	});
	
	_.forOwn(lambdaConfigMap, function (config, name) {
		app.post('/' + config.name, function (req, res) {
			console.log('POST /' + config.name);
			spawnLambda(config, req.body);
			res.send(getLambdaResponse(name));
		});
	});
	
	_.forOwn(lambdaConfigMap, function (config, name) {
		app.post('/sync/' + config.name, function (req, res) {
			console.log('POST /sync/' + config.name);
			spawnLambda(config, req.body).then(function () {
				res.send(getLambdaResponse(name));
			});
		});
	});
	
	app.listen(listenPort);
});

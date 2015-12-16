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

var lambdaBaseDir = process.argv[2] || process.env.LAMBDADEV_BASE_DIR || path.resolve(__dirname, '..', 'lambdas');
var defaultHandler = process.env.LAMBDADEV_DEFAULT_HANDLER || 'index.handler';
var defaultMaxMemory = parseInt(process.env.LAMBDADEV_DEFAULT_MAX_MEMORY) || 128;
var defaultTimeout = parseInt(process.env.LAMBDADEV_DEFAULT_TIMEOUT) || 3;
var maxConcurrency = parseInt(process.env.LAMBDADEV_MAX_CONCURRENCY) || 1;
var maxHistorySize = parseInt(process.env.LAMBDADEV_MAX_HISTORY) || 10;
var listenPort = parseInt(process.env.LAMBDADEV_PORT) || 8080;

var childMemoryCheckInterval = 100;

app.use(bodyParser.json());
app.set('json spaces', '  ');

var lambdaConfigMap = {};
var historyMap = {};
var metricsMap = {};
var aggrega = {counts: {total: 0, killed: {}}, averages: {initialization: {}}};
var queue = [];

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
						historyMap[lName] = [];
						metricsMap[lName] = {counts: {total: 0, killed: {}}, averages: {initialization: {}}};
					})
				;
			});
		})
	;
}

function getFormatedDate(date) {
	if (typeof date === 'number') {
		date = new Date(date);
	}
	return date.getUTCFullYear() + '-'
		+ ('0' + (date.getUTCMonth() + 1)).substr(-2) + '-'
		+ ('0' + date.getUTCDate()).substr(-2) + ' '
		+ ('0' + date.getUTCHours()).substr(-2) + ':'
		+ ('0' + date.getUTCMinutes()).substr(-2) + ':'
		+ ('0' + date.getUTCSeconds()).substr(-2) + '.'
		+ ('00' + date.getUTCMilliseconds()).substr(-3)
	;
}

function getProcessMemory(child) {
	return when.promise(function (resolve, reject) {
		var psChild = childProcess.spawn('ps', ['-p' + child.pid, '-o', 'vsize=']);
		
		var psOutput = new Buffer(0);
		psChild.stdout.on('data', function (data) {
			psOutput = Buffer.concat([psOutput, data]);
		});
		psChild.on('close', function () {
			resolve(parseInt(psOutput.toString(), 10) || null);
		});
	});
}

function spawnLambda(config, event) {
	return when.promise(function (resolve, reject) {
		var result, metrics, timeoutKill, periodicMemoryCheck;
		
		var result = {initialization: {}};
		var child = childProcess.spawn('node', [], {cwd: config.dirPath, stdio: [null, null, null, 'ipc']});
		
		child.stdout.on('data', function (data) {
			var now = new Date();
			var ms = now.getTime();
			
			result.updated = ms;
			result.output = result.output || [];
			result.output.push(getFormatedDate(now) + ': ' + data.toString());
		});
		child.stderr.on('data', function (data) {
			var now = new Date();
			var ms = now.getTime();
			
			result.updated = ms;
			result.error = result.error || [];
			result.error.push(getFormatedDate(now) + ': ' + data.toString());
			// result.duration = ms - result.startedTime;
		});
		child.on('error', function (error) {
			var now = new Date();
			var ms = now.getTime();
			
			metrics.counts.error = (metrics.counts.error || 0) + 1;
			aggrega.counts.error = (aggrega.counts.error || 0) + 1;
			result.status = 'error';
			result.updated = ms;
			result.error = result.error || [];
			result.error.push(getFormatedDate(now) + ': ' + error.toString());
			// result.duration = ms - result.startedTime;
		});
		child.on('close', function (code) {
			var now = new Date();
			var ms = now.getTime();
			
			metrics.counts.running--;
			aggrega.counts.running--;
			if (result.status === 'started') {
				metrics.counts.done = (metrics.counts.done || 0) + 1;
				aggrega.counts.done = (aggrega.counts.done || 0) + 1;
				result.status = 'done';
			}
			result.updated = ms;
			result.completed = ms;
			result.duration = ms - result.startedTime;
			
			metrics.averages.maxMemory = (result.maxMemory + (metrics.averages.maxMemory || 0) * (metrics.counts.total - 1)) / metrics.counts.total;
			aggrega.averages.maxMemory = (result.maxMemory + (aggrega.averages.maxMemory || 0) * (aggrega.counts.total - 1)) / aggrega.counts.total;
			metrics.averages.duration = (result.duration + (metrics.averages.duration || 0) * (metrics.counts.total - 1)) / metrics.counts.total;
			aggrega.averages.duration = (result.duration + (aggrega.averages.duration || 0) * (aggrega.counts.total - 1)) / aggrega.counts.total;
			
			clearTimeout(timeoutKill);
			clearInterval(periodicMemoryCheck);
			resolve();
		});
		child.on('message', function (message) {
			getProcessMemory(child).then(function (mem) {
				var now = new Date();
				var ms = now.getTime();
				
				result.status = 'running';
				result.initialization.memory = mem;
				result.initialization.duration = ms - result.initialization.started;
				result.startedTime = ms;
				
				metrics.counts.initialization--;
				aggrega.counts.initialization--;
				metrics.counts.running = (metrics.counts.running || 0) + 1;
				aggrega.counts.running = (aggrega.counts.running || 0) + 1;
				
				metrics.averages.initialization.memory = average(result.initialization.memory, metrics.averages.initialization.memory, metrics.counts.total);
				aggrega.averages.initialization.memory = average(result.initialization.memory, aggrega.averages.initialization.memory, aggrega.counts.total);
				metrics.averages.initialization.duration = average(result.initialization.duration, metrics.averages.initialization.duration, metrics.counts.total);
				aggrega.averages.initialization.duration = average(result.initialization.duration, aggrega.averages.initialization.duration, aggrega.counts.total);
				
				child.send({
					name: config.name,
					filename: config.handler.split('.', 1)[0] + '.js',
					exportHandler: config.handler.split('.', 2)[1],
					event: event
				});
				
				timeoutKill = setTimeout(function () {
					metrics.counts.killed.timeout = (metrics.counts.killed.timeout || 0) + 1;
					aggrega.counts.killed.timeout = (aggrega.counts.killed.timeout || 0) + 1;
					result.status = 'killed - timeout';
					child.kill();
				}, config.timeout * 1000);
				
				periodicMemoryCheck = setInterval(function () {
					getProcessMemory(child).then(function (mem) {
						if (mem === null || mem < (result.maxMemory || 0)) {
							return;
						}
						
						result.maxMemory = mem - result.initialization.memory;
						
						if (result.maxMemory > config.maxMemory) {
							metrics.counts.killed.maxMemory = (metrics.counts.killed.maxMemory || 0) + 1;
							aggrega.counts.killed.maxMemory = (aggrega.counts.killed.maxMemory || 0) + 1;
							result.status = 'killed - max memory';
							child.kill();
						}
					});
				}, childMemoryCheckInterval);
			});
		});
		
		var loaderInit = ""
			+ "'use strict';"
			+ "var context = {"
			+ "	succeed: function (data) {process.exit();},"
			+ "	fail: function (data) {process.exit(1);}"
			+ "};"
			+ "process.on('message', function (message) {"
			+ "	console.log('message', message);"
			+ "	var lambda;"
			+ "	try {"
			+ "		lambda = require('./' + message.filename);"
			+ "	} catch (error) {"
			+ "		if (error.code !== 'MODULE_NOT_FOUND') {"
			+ "			throw error;"
			+ "		}"
			+ "		console.error('a js file was not found that corresponds to the file component of the handler property in config.json: expected js file=' + message.filename + '; lambda=' + message.name);"
			+ "		process.exit(1);"
			+ "	}"
			+ "	if (typeof lambda[message.exportHandler] !== 'function') {"
			+ "		console.error('the exports property specified by the handler property in config.json was not found in the lambda js file: exports property expected=' + message.exportHandler + '; lambda js file=' + message.filename + '; lambda=' + message.name);"
			+ "		process.exit(1);"
			+ "	}"
			+ "	lambda[message.exportHandler](message.event, context);"
			+ "});"
			+ "process.send(process.pid + ' ready');"
		;
		child.stdin.setEncoding('utf-8');
		child.stdin.write(loaderInit);
		child.stdin.end();
		
		var now = new Date();
		
		result.status = 'initialization';
		result.initialization.started = now.getTime();
		
		var history = historyMap[config.name];
		history.unshift(result);
		if (history.length > maxHistorySize) {
			history.pop();
		}
		
		metrics = metricsMap[config.name];
		metrics.counts.total++;
		aggrega.counts.total++;
		metrics.counts.initialization = (metrics.counts.initialization || 0) + 1;
		aggrega.counts.initialization = (aggrega.counts.initialization || 0) + 1;
	});
}

function average(value, oldAverage, count) {
	return (value + (oldAverage || 0) * (count - 1)) / count;
}

function formatMetrics(data) {
	return {
		counts: (data.counts.total || undefined) && {
			total: data.counts.total,
			initialization: data.counts.initialization,
			running: data.counts.running,
			done: data.counts.done,
			error: data.counts.error,
			killed: {
				maxMemory: data.counts.killed.maxMemory,
				timeout: data.counts.killed.timeout
			}
		},
		averages: (data.counts.total || undefined) && {
			duration: data.averages.duration,
			maxMemory: data.averages.maxMemory && Math.ceil(data.averages.maxMemory / 1000),
			initialization: {
				duration: data.averages.initialization.duration,
				memory: data.averages.initialization.memory && Math.ceil(data.averages.initialization.memory / 1000)
			}
		}
	}
}

function getLambdaResponse(name) {
	var output = {};
	output.history = _.map(historyMap[name], function (result) {
		return {
			status: result.status,
			error: result.error,
			output: result.output,
			started: result.started && getFormatedDate(result.started),
			updated: result.updated && getFormatedDate(result.updated),
			completed: result.completed && getFormatedDate(result.completed),
			duration: result.duration,
			maxMemory: result.maxMemory && Math.ceil(result.maxMemory / 1000),
			initialization: {
				started: result.initialization.started && getFormatedDate(result.initialization.started),
				memory: result.initialization.memory && Math.ceil(result.initialization.memory / 1000),
				duration: result.initialization.duration
			}
		};
	});
	output.metrics = formatMetrics(metricsMap[name]);
	output.config = lambdaConfigMap[name];
	return output;
}

function processUntilDone(config, event) {
	spawnLambda(config, event).then(function () {
		var next = queue.shift();
		if (next) {
			var metrics = metricsMap[next.config.name];
			metrics.counts.queued--;
			aggrega.counts.queued--;
			processUntilDone(next.config, next.event)
		}
	});
}

function queueLambda(config, event) {
	if ((aggrega.counts.running || 0) < maxConcurrency) {
		processUntilDone(config, event);
	} else {
		queue.push({config: config, event: event});
		
		var metrics = metricsMap[config.name];
		metrics.counts.queued = (metrics.counts.queued || 0) + 1;
		aggrega.counts.queued = (aggrega.counts.queued || 0) + 1;
	}
}

loadLambdaBaseDir(lambdaBaseDir).then(function () {
	console.log('serving lambdas');
	
	app.get('/', function(req, res) {
		console.log('GET /');
		var output = {};
		_.forOwn(lambdaConfigMap, function (config, name) {
			output[name] = getLambdaResponse(name);
		});
		output.metrics = formatMetrics(aggrega);
		output.maxConcurrency = maxConcurrency;
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
			queueLambda(config, req.body);
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

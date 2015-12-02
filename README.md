# dev-lambda

Provide AWS Lambda like functionality for local Node.js development purposes.

## Purpose

Developing AWS lambda's isn't very hard but it would be nice to be able to serve them
locally for rapidly testing changes, offline development, and intergration testing.

## The System

- each lambda should be its own directory
- a parent directory contains all the lambdas to be served
- dev-lambdaprovides a simple REST API communicating in JSON
- the API can be used to list all available lambdas, simple metrics, and recent history of the output of each lambda
- the API can be used to pass event data and initiate lambdas
- the API provides a sync endpoint for each lambda for easier debugging

## Getting Started

First copy the example lambda directory into the lambdas directory so we have something to see once the server is up.

```
cp -r example-lambda lambdas/
```

Now we can kick off the server with Node.js, later we will do the same with a dockerizered version.

### Straight Node.js

```
node lib/daemon.js
```

Now visit `http://127.0.0.1:8080/` in your browser and you should see JSON saying something like:

```
{"example-lambda":{"config":{"name":"example-lambda","dirPath":"/Users/me/dev-lambda/lambdas/example-lambda","handler":"index.handler","maxMemory":128,"timeout":3}}}
```

So great, we can see that the example `example-lambda` is set up and ready. Lets run it, this is done by POSTing to `http://127.0.0.1:8080/example-lambda`.

using curl:

```
curl -X POST http://127.0.0.1:8080/example-lambda
```

or use something like the excellent Chrome App [Postman](http://www.getpostman.com)

and should get something like, look for the `Hello World!`:

```
{"metrics":{"counts":{"total":1,"started":0,"done":1},"averageDuration":103},"history":[{"status":"done","started":"2015-11-18 04:53:46.165","updated":"2015-11-18 04:53:46.268","output":["2015-11-18 04:53:46.264: Hello World!\n","2015-11-18 04:53:46.265: event {}\n"],"completed":"2015-11-18 04:53:46.268","duration":103}],"config":{"name":"example-lambda","dirPath":"/Users/me/dev-lambda/lambdas/example-lambda","handler":"index.handler","maxMemory":128,"timeout":3}}
```

Now we just need the ability to pass event data into the lambda. This is accomplished by POSTing JSON as a request body and having a `Content-Type: application/json` header.

```
curl -H "Content-Type: application/json" -X POST -d '{"abc":"123"}' http://127.0.0.1:8080/sync/example-lambda
```

results in something like:

```
{"metrics":{"counts":{"total":2,"started":0,"done":2},"averageDuration":105},"history":[{"status":"done","started":"2015-11-18 05:02:39.006","updated":"2015-11-18 05:02:39.109","output":["2015-11-18 05:02:39.105: Hello World!\n","2015-11-18 05:02:39.107: event { abc: '123' }\n"],"completed":"2015-11-18 05:02:39.109","duration":103},{"status":"done","started":"2015-11-18 05:01:56.730","updated":"2015-11-18 05:01:56.837","output":["2015-11-18 05:01:56.833: Hello World!\n","2015-11-18 05:01:56.834: event {}\n"],"completed":"2015-11-18 05:01:56.837","duration":107}],"config":{"name":"example-lambda","dirPath":"/Users/me/dev-lambda/lambdas/example-lambda","handler":"index.handler","maxMemory":128,"timeout":3}}
```

### Using Docker

```
docker build -t dev-lambda .
```

```
docker run -ti -p 8080:8080 -v /Users/me/my-lambdas/:/usr/src/app/lambdas dev-lambda
```

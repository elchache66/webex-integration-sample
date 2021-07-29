//
// Copyright (c) 2016 Cisco Systems
// Licensed under the MIT License
//

/*
 * a Webex OAuth Integration based on Node.js, that acts on user's behalf.
 * implements the Webex OAuth flow, to retreive an API access tokens.
 *
 * See documentation: https://developer.webex.com/authentication.html
 *
 */

var debug = require("debug")("oauth");
var fine = require("debug")("oauth:fine");

var request = require("request");
var express = require("express");
var app = express();

//
// Step 0: create an OAuth integration from https://developer.webex.com/add-integration.html
//   - then fill in your Integration properties below
//
var clientId =
  process.env.CLIENT_ID ||
  "C4d2626189e40ffbde5f8d2948650bda5b4261804986bb3a977b079d2af2d7d93";
var clientSecret =
  process.env.CLIENT_SECRET ||
  "81772d83ee75a5835d2b19a1c9e95b47bf6618a3a736e361c5324dc18e7183e8";
var port = process.env.PORT || 8080;
var redirectURI = process.env.REDIRECT_URI || `http://localhost:${port}/oauth`; // where your integration is waiting for Webex cloud to redirect and send the authorization code
var state = process.env.STATE || "CiscoDevNet"; // state can be used for security and/or correlation purposes
var scopes = "spark:all"; // supported scopes are documented at: https://developer.webex.com/add-integration.html, the scopes separator is a space, example: "spark:people_read spark:rooms_read"

//
// Step 1: initiate the OAuth flow
//   - serves a Web page with a link to the OAuth flow initializer
//
// Initiate the OAuth flow from the 'index.ejs' template
// -------------------------------------------------------------
// -- Comment this section to initiate the flow from  static html page
var initiateURL =
  "https://api.ciscospark.com/v1/authorize?" +
  "client_id=" +
  clientId +
  "&response_type=code" +
  "&redirect_uri=" +
  encodeURIComponent(redirectURI) +
  "&scope=" +
  encodeURIComponent(scopes) +
  "&state=" +
  state;
var read = require("fs").readFileSync;
var join = require("path").join;
var str = read(join(__dirname, "/www/index.ejs"), "utf8");
var ejs = require("ejs");
var compiled = ejs.compile(str)({ link: initiateURL }); // inject the link into the template
app.get("/index.html", function (req, res) {
  debug("serving the integration home page (generated from an EJS template)");
  res.send(compiled);
});
app.get("/", function (req, res) {
  res.redirect("/index.html");
});

// -------------------------------------------------------------
// Statically serve the "/www" directory
// WARNING: Do not move the 2 lines of code below, as we need this exact precedance order for the static and dynamic HTML generation to work correctly all together
//          If the section above is commented, the static index.html page will be served instead of the EJS template.
var path = require("path");
app.use("/", express.static(path.join(__dirname, "www")));

//
// Step 2: process OAuth Authorization codes
//
app.get("/oauth", function (req, res) {
  debug("oauth callback hitted");

  // Did the user decline
  if (req.query.error) {
    if (req.query.error == "access_denied") {
      debug("user declined, received err: " + req.query.error);
      res.send(
        "<h1>OAuth Integration could not complete</h1><p>Got your NO, ciao.</p>"
      );
      return;
    }

    if (req.query.error == "invalid_scope") {
      debug("wrong scope requested, received err: " + req.query.error);
      res.send(
        "<h1>OAuth Integration could not complete</h1><p>The application is requesting an invalid scope, Bye bye.</p>"
      );
      return;
    }

    if (req.query.error == "server_error") {
      debug("server error, received err: " + req.query.error);
      res.send(
        "<h1>OAuth Integration could not complete</h1><p>Webex sent a Server Error, Auf Wiedersehen.</p>"
      );
      return;
    }

    debug("received err: " + req.query.error);
    res.send(
      "<h1>OAuth Integration could not complete</h1><p>Error case not implemented, au revoir.</p>"
    );
    return;
  }

  // Check request parameters correspond to the spec
  if (!req.query.code || !req.query.state) {
    debug("expected code & state query parameters are not present");
    res.send(
      "<h1>OAuth Integration could not complete</h1><p>Unexpected query parameters, ignoring...</p>"
    );
    return;
  }

  // Check State
  // [NOTE] we implement a Security check below, but the State variable can also be leveraged for Correlation purposes
  if (state != req.query.state) {
    debug("State does not match");
    res.send(
      "<h1>OAuth Integration could not complete</h1><p>Wrong secret, aborting...</p>"
    );
    return;
  }

  // Retreive access token (expires in 14 days) & refresh token (expires in 90 days)
  //   {
  //      "access_token":"N2MxMmE0YzgtMjY0MS00MDIxLWFmZDItNTg0MGVkOWEyNWQ3YmMzMmFlODItYzAy",
  //      "expires_in":1209599,
  //      "refresh_token":"NjBjNDk3MjktMjUwMy00YTlkLWJkOTctM2E2MjE3YWU1NmI4Njk3Y2IzODctMjBh",
  //      "refresh_token_expires_in":7775999
  //   }
  var options = {
    method: "POST",
    url: "https://api.ciscospark.com/v1/access_token",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    form: {
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code: req.query.code,
      redirect_uri: redirectURI,
    },
  };
  request(options, function (error, response, body) {
    if (error) {
      debug("could not reach Webex cloud to retreive access & refresh tokens");
      res.send(
        "<h1>OAuth Integration could not complete</h1><p>Sorry, could not retreive your access token. Try again...</p>"
      );
      return;
    }

    if (response.statusCode != 200) {
      debug("access token not issued with status code: " + response.statusCode);
      switch (response.statusCode) {
        case 400:
          var responsePayload = JSON.parse(response.body);
          res.send(
            "<h1>OAuth Integration could not complete</h1><p>Bad request. <br/>" +
              responsePayload.message +
              "</p>"
          );
          break;
        case 401:
          res.send(
            "<h1>OAuth Integration could not complete</h1><p>OAuth authentication error. Ask the service contact to check the secret.</p>"
          );
          break;
        default:
          res.send(
            "<h1>OAuth Integration could not complete</h1><p>Sorry, could not retreive your access token. Try again...</p>"
          );
          break;
      }
      return;
    }

    // Check payload
    var json = JSON.parse(body);
    if (
      !json ||
      !json.access_token ||
      !json.expires_in ||
      !json.refresh_token ||
      !json.refresh_token_expires_in
    ) {
      debug("could not parse access & refresh tokens");
      res.send(
        "<h1>OAuth Integration could not complete</h1><p>Sorry, could not retreive your access token. Try again...</p>"
      );
      return;
    }
    debug("OAuth flow completed, fetched tokens: " + JSON.stringify(json));

    // OAuth flow completed
    oauthFlowCompleted(json.access_token, res);
  });
});

//
// Step 3: this is where the integration runs its custom logic
//   - this function is called as the OAuth flow has been successfully completed,
//   - this function is expected to send back an HTML page to the end-user
//
// some optional activities to perform here:
//    - associate the issued access token to a user through the state (acting as a Correlation ID)
//    - store the refresh token (valid 90 days) to reissue later a new access token (valid 14 days)
function oauthFlowCompleted(access_token, res) {
  //
  // Custom logic:
  //  - retreive the user's email
  //  - have a bot add the user to the demo space
  //  - then open the demo space from the Space Widget

  // Retreive the user's email
  var Sparky = require("node-sparky");
  var userClient = new Sparky({
    token: access_token,
  });
  userClient
    .personMe()
    .then(function (person) {
      // Add the user to the demo space
      var botClient = new Sparky({
        token: process.env.BOT_TOKEN,
      });

      botClient
        .membershipAdd(process.env.SPACE_ID, person.emails[0], false)
        .then(function (membership) {
          // Show widget
          res.send(showSpaceWidget(access_token, process.env.SPACE_ID));
          return;
        })
        .catch(function (err) {
          // Has HTTP Status Code
          var hasHttpStatusCode = err.message.match(
            /recieved error (\d{3}) for a POST request/
          );
          if (hasHttpStatusCode && hasHttpStatusCode[1] == "409") {
            // The user is already part of the space
            console.log("INFO: user already in space, continuing");

            // Show widget
            res.send(showSpaceWidget(access_token, process.env.SPACE_ID));
            return;
          }

          res.send(
            "<h1>OAuth Integration Spaces</h1><p>Could not add you to the Demo Space<br/>Error: " +
              err.message +
              "</p>"
          );
          return;
        });
    })
    .catch(function (err) {
      // Process error
      res.send(
        "<h1>OAuth Integration Spaces</h1><p>Could not retreive your Person details<br/>Error: " +
          err.message +
          "</p>"
      );
      return;
    });
}

function showSpaceWidget(token, spaceId) {
  var read = require("fs").readFileSync;
  var join = require("path").join;
  var str = read(join(__dirname, "./togofurther/widget.ejs"), "utf8");
  var ejs = require("ejs");
  return ejs.compile(str)({
    token: token,
    spaceId: spaceId,
  });
}

// Fail fast if no BOT_TOKEN is specified
if (!process.env.BOT_TOKEN || !process.env.SPACE_ID) {
  console.log(
    "Please specify a BOT_TOKEN and a SPACE_ID moderated by the bot, as environment variables"
  );
  process.exit(1);
}

// Starts the OAuth Integration
app.listen(port, function () {
  console.log("Webex OAuth Integration started on port: " + port);
});

/**
 * GitBit Bot for Slack ! 
 * @author: Vasu Jain
 */

// Libraries
var https = require('https');
var BotConfig = require('./config.json');
var Botkit = require("botkit");
var beepboop = require("beepboop-botkit");
var teamMap = Object.create(null);

function onInstallation(bot, installer) {
    if (installer) {
        bot.startPrivateConversation({
            user: installer
        }, function(err, convo) {
            if (err) {
                console.log(err);
            } else {
                convo.say('I am GitBit bot that has just joined your team');
                convo.say('You must now /invite me to a channel so that I can be of use!');
            }
        });
    }
}

// Configure the persistence options
var config = {};
if (process.env.MONGOLAB_URI) {
    var BotkitStorage = require('botkit-storage-mongo');
    config = {
        storage: BotkitStorage({
            mongoUri: process.env.MONGOLAB_URI
        })
    };
} else {
    config = {
        json_file_store: ((process.env.TOKEN) ? './db_slack_bot_ci/' : './db_slack_bot_a/') //use a different name if an app or CI
    };
}

var token = process.env.SLACK_TOKEN;
var controller = Botkit.slackbot({
    debug: false
});

var slackTokenEncrypted = "eG94Yi00MjUyNzYwMzU5MC0wakp0M3JoNEc5WDN5VmNNdU1HWXRBVWM=";
var slackTokenBuf = new Buffer(slackTokenEncrypted, 'base64');
var token = slackTokenBuf.toString("ascii");
console.log(token);

//default config variable would be read from config.json, would be overwrite, if custom config found
var REPO_ORG = BotConfig.repo_org;
var GITHUB_API_URL = BotConfig.github_api_url;
var GITHUB_AUTH_TOKEN = BotConfig.auth_token;
var MAX_PAGE_COUNT = BotConfig.max_page_count;
var DISABLE_ZERO_PR_REPO = BotConfig.disable_zero_pr_repo;
var authTokenDecrypted = "token " + new Buffer(GITHUB_AUTH_TOKEN, 'base64').toString("ascii");

if (token) {
    console.log("Starting in single-team mode");
    controller.spawn({
        token: token
    }).startRTM(function(err, bot, payload) {
        console.log("Loaded config parameters from config.json ");
        if (err) {
            console.log(err);
            throw new Error(err);
        }
    });
} else {
    console.log("Starting in Beep Boop multi-team mode");
    var beepboopboop = require('beepboop-botkit').start(controller, {
        debug: true
    });
    beepboopboop.on('add_resource', function(message) {
        console.log("Loading config parameters from Custom bot Config");
        REPO_ORG = message.resource.REPO_ORG;
        GITHUB_API_URL = message.resource.GITHUB_API_URL;
        GITHUB_AUTH_TOKEN = message.resource.GITHUB_AUTH_TOKEN;
        MAX_PAGE_COUNT = message.resource.MAX_PAGE_COUNT;
        DISABLE_ZERO_PR_REPO = message.resource.DISABLE_ZERO_PR_REPO;
        authTokenDecrypted = "token " + new Buffer(GITHUB_AUTH_TOKEN, 'base64').toString("ascii");
    });
}
//For debugging purposes
//console.log("REPO_ORG-" + REPO_ORG + " GITHUB_API_URL--" + GITHUB_API_URL);

// Handle events related to the websocket connection to Slack
controller.on('rtm_open', function(bot) {
    console.log('** The RTM api just connected!');
});

controller.on('rtm_close', function(bot) {
    console.log('** The RTM api just closed');
    // you may want to attempt to re-open
});

/* ************************* SLACK BOT CONTROLLER ******************************** */
// Core bot logic !
controller.on('bot_channel_join', function(bot, message) {
    bot.reply(message, "Thank you for inviting me to your Slack Channel!");
});

controller.hears(['hello', 'hi', 'greetings'], ['direct_mention', 'mention', 'direct_message'], function(bot, message) {
    bot.reply(message, 'Hello!');
});

controller.hears('pr (.*)', ['direct_mention', 'mention', 'direct_message'], function(bot, message) {
    var repo = message.match[1];
    if (typeof repo !== 'undefined' && repo) {
        var githubRepo = BotConfig.repos[repo];
        var flagZeroPRComment = false;
        //Check and throw error if team is invalid -- Object.keys(bb.repos.teams).length
        if (isValidTeam(repo, Object.keys(BotConfig.repos.teams))) {
            var key = repo,
                teamRepos;
            BotConfig.repos.teams.some((v) => Object.keys(v).indexOf(key) !== -1 && (teamRepos = v[key]), teamRepos);
            teamRepos.forEach(function(teamRepo) {
                githubGetPullRequest(teamRepo, bot, message, flagZeroPRComment);
            });
        } else if (repo == 'all') {
            getListOfAllGithubReposInOrg(bot, message);
        } else {
            botErrorHandler("Invalid Repo or Repo not configured", bot, message);
        }
    } else {
        botErrorHandler("Repo is undefined -- Invalid request or Repo not configured", bot, message);
    }
});

controller.hears('help', ['direct_mention', 'mention', 'direct_message'], function(bot, message) {
    console.log("Help !! -- Listing all the supported commands ...");
    var helpMsg = ":point_right: Use the following commands to use GitBit.\n";
    var helpCommand = "";
    helpCommand += ":pushpin: help - Gets list of all commands you can use with GitBit. \n";
    helpCommand += ":pushpin: pr {team_name} - Gets pull request for all repos for your team customized in config.json. e.g. 'pr pelican' . \n";
    helpCommand += ":pushpin: pr custom - Gets pull request for all repos for your custom team customized in config.json. \n";
    helpCommand += ":pushpin: pr all - Gets pull request for all repos in your organization (Max result ssize defined in config). \n";
    helpCommand += ":pushpin: github issues - Gets list of all issues in a repo in your organization woth specific issue-label. \n";
    bot.reply(message, {
        "attachments": [{
            "fallback": helpCommand,
            "color": "#FFFF00",
            "title": helpMsg,
            "text": helpCommand
        }]
    });
});

controller.hears('github issues', ['direct_mention', 'mention', 'direct_message'], function(bot, message) {
    console.log("GitHub issues !! ");
    var labels = BotConfig.github_issues.labels;
    var organizations = BotConfig.github_issues.organizations;
    var repos = organizations[0].paypal;
    var repoOrg = Object.keys(BotConfig.github_issues.organizations[0]);
    repos.forEach(function(repo) {
        githubGetIssuesWithLabel(repo, repoOrg, bot, message, labels[0]);
    });
});

/* ************************* GITHUB FUNCTIONS ******************************** */
// Make a POST call to GITHUB API to fetch all OPEN PR's
function githubGetPullRequest(repo, bot, message, flagZeroPRComment) {
    console.log("Making a GET call to GITHUB API to fetch all OPEN PR's...");
    var request = require('request');
    var url = GITHUB_API_URL + 'repos/' + REPO_ORG + repo + '/pulls?state=open';
    console.log(url);
    request({
        headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': authTokenDecrypted,
            'User-Agent': 'GitBit-slackbot'
        },
        uri: url,
        method: 'GET'
    }, function(err, res, body) {
        //        console.log("repo + body" + repo + body);   //For debugging purposes
        parseAndResponse(body, bot, message, repo, flagZeroPRComment);
    });
}

// Make a POST call to GITHUB API to fetch all Issues with specific Label's
function githubGetIssuesWithLabel(repo, repoOrg, bot, message, label) {
    console.log("Making a GET call to GITHUB API to fetch all Issues With Label");
    var url = 'https://api.github.com/' + 'repos/' + repoOrg + '/' + repo + '/issues?labels=' + label;
    var request = require('request');
    request({
        headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'GitBit-slackbot'
        },
        uri: url,
        method: 'GET'
    }, function(err, res, body) {
        //console.log("repo + body" + repo + body); //For debugging purposes
        parseAndResponseIssuesJson(body, bot, message, repo, repoOrg, label);
    });
}

// Parse the Org Repos response json and extracting Repo details out of it.
function constructAllGithubRepoObject(body, bot, message) {
    console.log("Parsing the Org Repos response json and extracting Repo details out of it...");
    var orgGithubRepo = new Array();
    var obj = JSON.parse(body);
    var objLength = obj.length;
    for (var i = 0; i < objLength; i++) {
        orgGithubRepo.push(obj[i].name);
        githubGetPullRequest(obj[i].name, bot, message, false);
    }
    console.log("constructAllGithubRepoObject executed successfully.\n");
}

/* ************************* GITHUB API RESPONSE PARSERS ******************************** */
// Parse the pull response json and extract PR#, Title, User out of it.
function parseAndResponse(body, bot, message, repo, flagZeroPRComment) {
    console.log("Parsing the pull response json and extracting PR#, Title, User out of it...");
    //    console.log(body);    
    var repoSource = ":shipit: " + REPO_ORG + repo + " Open Pull Requests : ";
    var response = "";
    var obj = JSON.parse(body);
    var objLength = obj.length;
    if (obj.length == 0) {
        if (!DISABLE_ZERO_PR_REPO) { //if false, then only display Repo with Zero PR 
            response = repoSource;
            if (flagZeroPRComment) {
                response += "No open PR's @ the moment ! Are you guys coding ?";
            } else {
                response += "0.";
            }
            bot.reply(message, response);
        }
    } else {
        for (var i = 0; i < objLength; i++) {
            response += "\n :construction: PR # " + obj[i].number + " - " + obj[i].title + " by " + obj[i].user.login;
        }
        bot.reply(message, {
            "attachments": [{
                "fallback": repoSource,
                "color": "#36a64f",
                "title": repoSource,
                "text": response
            }]
        });
    }
    console.log(response);
    console.log("parseAndResponse for " + repo + " with " + objLength + " PR'(s) executed successfully.");
}

// Parse the issue response json and extracting details out of it.
function parseAndResponseIssuesJson(body, bot, message, repo, repoOrg, label) {
    console.log("Parsing the issue response json and extracting details out of it...");
    var repoSource = ":fire_engine: " + repoOrg + "/" + repo + " Issues with label : " + label;
    var response = "";
    var obj = JSON.parse(body);
    var objLength = obj.length;
    if (obj.length > 0) {
        for (var i = 0; i < objLength; i++) {
            var issue_icon = "";
            if (obj[i].title == "open") {
                issue_icon = ":no_entry:";
            }
            else {
                issue_icon = ":white_check_mark:";
            }
            response += "\n " + issue_icon + " PR # " + obj[i].title + " - " + obj[i].number + " by " + obj[i].user.login;
        }
        bot.reply(message, {
            "attachments": [{
                "fallback": repoSource,
                "color": "#36a64f",
                "title": repoSource,
                "text": response
            }]
        });
    }
    console.log(response);
    console.log("parseAndResponseIssuesJson for " + repo + " with " + objLength + " Issues'(s) executed successfully.");
}

// Getting list of all Github Repos in an Org. Can be 100+. For the initial phase only top 100 results will display
function getListOfAllGithubReposInOrg(bot, message) {
    console.log("Getting list of all Github Repos in an Org. Can be 100+....");
    var ghArray = new Array();
    var url = GITHUB_API_URL + 'orgs/' + REPO_ORG + 'repos?per_page=' + MAX_PAGE_COUNT;
    console.log(url);
    var request = require('request');
    request({
        headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': authTokenDecrypted,
            'User-Agent': 'GitBit-slackbot'
        },
        uri: url,
        method: 'GET'
    }, function(err, res, body) {
        if (err)
            botErrorHandler(err, bot, message);
        else
            ghArray = constructAllGithubRepoObject(body, bot, message);
    });
    console.log("getListOfAllGithubReposInOrg executed successfully.\n");
}

/* ************************* UTILITY FUNCTIONS ******************************** */
// Bot Error Handler
function botErrorHandler(err, bot, message) {
    console.log("\n" + err);
    var errText = ":rotating_light: " + err;
    bot.reply(message, {
        "attachments": [{
            "fallback": err,
            "color": "#FF0000",
            "title": Error,
            "text": errText
        }]
    });
}

// Check if a Valid team name slected in slack channel. Matches with config.json 
function isValidTeam(repo, teamObj) {
    var teamLength = teamObj.length;
    for (var i = 0; i < teamLength; i++) {
        var teamStr = Object.keys(BotConfig.repos.teams[i]);
        if (teamStr == repo) {
            console.log("isValidRepo:true\n");
            return true;
        }
    }
    console.log("isValidRepo:false\n");
    return false;
}
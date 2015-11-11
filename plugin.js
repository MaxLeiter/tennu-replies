const Replies = require("./replies");
const format = require('util').format;
const Promise = require('bluebird');
// Promise.onPossiblyUnhandledRejection(function () {});
const Result = require('r-result');
const Ok = Result.Ok;
const Fail = Result.Fail;

const splitAt = function (string, match) {
    const matchIx = string.indexOf(match);

    if (matchIx === -1) {
        return [string, ""];
    }

    const first = string.slice(0, matchIx);
    const rest = string.slice(matchIx + match.length);

    return [first, rest];
};

const trim = function (string) {
    return string.replace(/^\s+|\s+$/g, "");
};

const startsWith = function (string, prefix) {
    return string.indexOf(prefix) === 0;
};

const endsWith = function (string, postfix) {
    return string.lastIndexOf(postfix) === string.length - postfix.length;
};

// Binds the last `n` arguments of a function where `n` is the length of `args`.
const bindr = function (fn, args) {
    return function () {
        return fn.apply(null, Array.prototype.slice.call(arguments).concat(args));
    };
};

module.exports = {
    init: function (client, imports) {
        const commandTrigger = client.config("command-trigger");
        const replyTrigger = client.config("replies-trigger");
        const databaseLocation = client.config("replies-database");
        const maxAliasDepth = client.config("replies-max-alias-depth") || 3;
        const delay = client.config("replies-delay");
        const daemon = client.config("daemon");

        const adminPlugin = client.getRole("admin");
        var requiresAdmin, isAdmin;
        if (adminPlugin) {
            requiresAdmin = adminPlugin.requiresAdmin;
            isAdmin = adminPlugin.isAdmin;
        } else {
            isAdmin = function () { return Promise.resolve(false); }
        }

        const beforeUpdate = function () {
            if (daemon !== "twitch") {
                return Ok;
            }

            return function (reply) {
                if (reply.intent === "say" && (reply.message[0] === "!" || reply.message[0] === "/")) {
                    return Fail("maybe-twitch-command");
                } else {
                    return Ok(reply);
                }
            };
        }();

        const replies = Replies({
            databaseLocation: databaseLocation, 
            isEditorAdmin: isAdmin,
            maxAliasDepth: maxAliasDepth,
            beforeUpdate: beforeUpdate,
            delay: delay
        });

        // Privmsg -> Bool
        function isReplyRequest (privmsg) {
            return privmsg.message.indexOf(replyTrigger) === 0;
        }

        // String -> String
        function getReplyKey (message) {
            return trim(message.slice(replyTrigger.length).replace(/\s+/g, " "));
        }

        function getReply (request, respondWhenNoKey) {
            var split = splitAt(request, "@");
            var key = trim(split[0]);
            var who = trim(split[1]);

            var response = replies.get(key)
            .map(function (response) {
                if (who && response.intent === "say") {
                    response.message = format("%s: %s", who, response.message);
                }

                return response;
            })
            .unwrapOrElse(function (failureReason) {
                switch (failureReason) {
                    case "max-alias-depth-reached":
                    return "Error: Max alias depth reached.";
                    case "no-reply":
                    client.note("PluginAutoReply", format("Key '%s' not found.", key));
                    return respondWhenNoKey ? format("No such reply '%s' found.", key) : undefined;
                    default:
                    client.error("PluginAutoReply", format("Unhandled failure reason in !get: %s", failureReason));
                    return format("Error: Unhandled failure reason in getting reply ('%s').", failureReason);
                }
            });

            return response;
        }
        var newTime = 0;
        const handlers = {
            privmsg: function (privmsg) {
                var timer = Date.now();
                var totalTime = timer - newTime;
                if(totalTime > delay) {//add bracket
                    var splitMessage = privmsg.message.split(" ");
                    splitMessage.forEach(function(e, i, a) {
                        if(replies.get(e).is_ok) {
                            newTime = Date.now();
                            client.say(privmsg.channel, getReply(e).message);
                        }
                    });
                }
            },

            "!reply": function (command) {
                if (command.args.length === 0) {
                    return "No reply specified.";
                }
                return getReply(command.args.join(" "), true);
            },

            "!learn": function (command) {
                // args is [key, description]
                const args = splitAt(command.args.join(" "), "=");
                const fullkey = args[0];
                const modifier = fullkey.slice(-1);
                const key = trim(fullkey.slice(0, -1));
                const description = trim(args[1]);

                function learn (key, description, intent) {
                    description = {
                        intent: intent,
                        message: trim(description),
                        editor: command.hostmask
                    };

                    return replies.set(key, description)
                    .then(bindr(Result.map, function (description) {
                        client.note("ReplyPlugin", format("Reply: '%s' => [%s] %s", key, description.intent, description.message));
                        return format("Learned reply '%s'.", key);
                    }));
                }

                function edit (key, replacement) {
                    function extractReplacement (replacement) {
                        replacement = trim(replacement);

                        // This regular expression is made of layers.
                        // The outer layer is r### ^s/_/_/_$ ###
                        // The inner layer is r### (([^/]|\/)*) ###
                        // The third part just allows 'g's and 'i's.
                        // The inner layer is for allowing anything except
                        // for "/" except when escaped e.g. "\/".
                        // Because "\" and "/" are special characters, they're
                        // escaped in the regexp, making it a huge mess of
                        // forwards and backwards slashes.
                        //
                        // The match will return `null` if it fails to match,
                        // but if it succeeds, it'll return an array-like where
                        // the numbers chosen in the returned object are the
                        // matched groups. The 0th element is the entire match
                        // while the even elements are the last instance of the
                        // inner parenthesis group, which is the last character
                        // of the outer parenthesis group of the inner layer.
                        replacement = replacement.match(/^s\/(([^\/]|\\\/)*)\/(([^\/]|\\\/)*)\/([gi]*)$/);

                        if (replacement === null) {
                            return Fail("bad-replace-format");
                        } else {
                            return Ok({
                                find: replacement[1],
                                replace: replacement[3].replace(/\\\//g, "/"),
                                flags: replacement[5]
                            });
                        }
                    }

                    return Promise.try(function () {
                        return extractReplacement(replacement)
                        .andThen(function (replacementObject) {
                            try {
                                const regexp = new RegExp(replacementObject.find, replacementObject.flags);
                            } catch (e) {
                                return Fail("bad-replace-regexp");
                            }

                            return replies.replace(key, regexp, replacementObject.replace, command.hostmask);
                        });
                    })
                    .then(bindr(Result.map, function (description) {
                        client.note("AutoReplyPlugn", format("Reply: '%s' => [%s] %s", key, description.intent, description.message));
                        return format("Successfully did replacement on '%s'.", key);
                    }));
                }

                function alias (key, aliasedKey) {
                    return replies.set(key, {
                        intent: "alias",
                        message: aliasedKey, 
                        editor: command.hostmask
                    })
                    .then(bindr(Result.map, function () {
                        client.note("AutoReplyPlugn", format("Reply: '%s' => [alias] %s", key, aliasedKey));
                        return format("Learned alias '%s' => '%s'.", key, aliasedKey);
                    }));
                }

                return Promise.try(function () {
                    if (!fullkey) {
                        return Fail("bad-format-no-key");
                    }

                    if (!description) {
                        return Fail("bad-format-no-desc");
                    }

                    return Ok();
                })
                .then(bindr(Result.andThen, function () {
                    switch (modifier) {
                        case "~": return edit(key, description);
                        case ":": return learn(key, format("%s is %s", key, description), "say");
                        case "!": return learn(key, description, "act");
                        case "+": return edit(key, format("s/$/ %s/", description.replace(/\//g, "\\/")));
                        case "@": return alias(key, description);
                        default: return learn(trim(fullkey), description, "say");
                    }
                }))
                .then(bindr(Result.unwrapOrElse, function (failureReason) {
                    switch (failureReason) {
                        case "dne":                 return format("Cannot edit '%s'. Reply does not exist.", key);
                        case "frozen":               return format("Cannot edit '%s'. Reply is locked.", key);
                        case "unchanged":            return format("Replacement on '%s' had no effect.", key);
                        case "no-message-left":      return format("Cannot edit '%s'. Would leave reply empty. Use %sforget instead.", key, commandTrigger);
                        case "bad-replace-format":   return format("Invalid replacement format. See %shelp learn replace for format.", commandTrigger);
                        case "bad-replace-regexp":   return "Invalid replacement format. RegExp invalid.";
                        case "bad-format-no-key":    return "Invalid format. No key specified.";
                        case "bad-format-no-desc":   return "Invalid format. No description specified.";
                        case "maybe-twitch-command": return "Disallowed! Reply message could be a Twitch command.";
                        default:
                        client.error("AutoReplyPlugn", format("Unhandled failure reason in !learn: %s", failureReason));
                        return format("Error: Unhandled failure reason in text replacement ('%s').", failureReason);
                    }
                }))
.catch(function internalError (err) {
    client.error("AutoReplyPlugn", "Error: " + err.name);
    client.error(err.stack);
    client.say(command.channel, "Error: Internal Error.");
});
},

"!forget": function (command) {
    var key;

    return Promise.try(function () {
        if (command.args.length === 0) {
            return Fail("no-args");
        } else {
            return Ok();
        }
    })
    .then(bindr(Result.andThen, function () {
        key = command.args.join(" ");
        return replies.delete(key, command.hostmask);
    }))
    .then(bindr(Result.andThen, function () {
        client.note("AutoReplyPlugn", format("Reply forgotten: %s", key));
        return Ok(format("Forgotten reply '%s'", key));
    }))
    .then(bindr(Result.unwrapOrElse, function (reason) {
        switch (reason) {
            case "dne":     return format("Cannot forget reply '%s'. Reply does not exist.", key);
            case "no-args": return        "Cannot forget reply. No reply specified.";
            case "frozen":  return format("Cannot forget reply '%s'. Reply is locked.", key);
            default:
            client.error("AutoReplyPlugn", format("Unhandled failure reason in !forget: %s", failureReason));
            return format("Error: Unhandled failure reason in text replacement ('%s').", failureReason);
        }
    }))
    .catch(function internalError (err) {
        client.error("AutoReplyPlugn", "Error: " + err.name);
        client.error(err.stack);
        client.say(command.channel, "Error: Internal Error.");
    });
}
};

const helpfiles = {
    "replies": [
    "Replies are automatic replies to common queries",
    "",
    format("You can look up a reply with `{{!}}reply key` or %skey.", replyTrigger),
    "You can teach this bot a reply with `{{!}}learn`.",
    "You can also make the bot forget a reply with `{{!}}forget key`.",
    "Admins can make certain replies unmodifiable.",
    "For more information, do {{!}}help command-name."
    ],

    "reply": [
    "{{!}}reply key",
    format("%skey", replyTrigger),
    "",
    "Look up a reply.",
    "Replies are small messages this bot responds with.",
    "",
    "You may add an '@ nick' to the end to have the bot say",
    "the response to that user.",
    "",
    "See also: {{!}}learn, {{!}}forget"
    ],

    "learn": {
        "*": [
        "{{!}}learn reply-key = reply-description",
        " ",
        "Adds a reply to the replies database.",
        "This bot also supports a modifier before the `=`.",
        "To see them, do {{!}}help learn formats",
        "",
        "Keys may consist of all characters other than `=` and `@`."
        ],

        "formats": [
        "{{!}}learn key = description",
        "Sets the bot to just say whatever the description is.",
        " ",
        "{{!}}learn key := description",
        "As previous, but prefixes description with '<key> is '.",
        "When using this, the case matters for your key.",
        " ",
        "{{!}}learn key != action",
        "As the initial, but has the bot act the action.",
        " ",
        "{{!}}learn key @= other key",
        "Makes key an alias for `other key`.",
        format("There is a maximum alias depth of %s.", maxAliasDepth),
        "Modifying the value with += or ~= modifies which key is being aliased,",
        "not the value of the aliased key.",
        " ",
        "{{!}}learn key += amendment",
        "Modifies an existing reply to add more information.",
        "A space is automatically added between the prior description",
        "and the amended text.",
        " ",
        "{{!}}learn key ~= s/regexp/replacement/flags",
        "Modifies an existing reply by finding the first match",
        "of the regexp in the current reply, and replacing it",
        "with the replacement.",
        "Escape '/' by doing '\\/'.",
        "Flag: 'g' - Replaces all occurences of the RegExp",
        "Flag: 'i' - Makes the RegExp case insensitive.",
        "See also: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp"
        ]
    },

    "forget": [
    "{{!}}forget reply-name"
    ]
};

if (requiresAdmin) {
    handlers["!lock"] = requiresAdmin(function (command) {
        const reply = command.args.join(" ").toLowerCase()
        replies.freeze(reply);
        return format("Locked reply '%s'.", reply);
    });

    helpfiles["lock"] = [
    "{{!}}lock reply-name",
    "",
    "Locks a reply so only an admin can edit it.",
    "Requires admin privileges.",
    "Use {{!}}unlock to undo this."
    ];

    handlers["!unlock"] = requiresAdmin(function (command) {
        const reply = command.args.join(" ").toLowerCase()
        replies.unfreeze(reply);
        return format("Unlocked reply '%s'.", reply);
    });

    helpfiles["unlock"] = [
    "{{!}}unlock reply-name",
    "",
    "Unlocks a locked reply so that anybody can edit it.",
    "Requires admin privileges."
    ];
}

return {
    handlers: handlers,
    help: helpfiles,
    commands: Object.keys(handlers)
    .filter(function (handler) { return handler[0] === "!"; })
    .map(function (command) { return command.slice(1); })
};
}
};
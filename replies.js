/**
 * Dirty DB is an append only database that emulates a JSON object.
 *
 * Our database has keys of replies, with a value being the
 * following struct:
 *
 * %Reply{
 *   intent: %Tennu.Message{}'s intent ^1
 *   message: %Tennu.Message{}'s message ^1
 *   editor: Full hostmask of last editor to the reply.
 *   time: Time of modification.
 *   frozen: Boolean of whether only admins can edit the reply.
 * }^2
 *
 * 1: Will be missing if the message is deleted.
 * 2: Replies that were never created but frozen will just be {frozen: true}.
 **/

const Dirty = require('dirty');
const Promise = require('bluebird');
const format = require('util').format;
const now = function () { return (new Date()).toISOString(); }
const Result = require('r-result');
const Ok = Result.Ok;
const Fail = Result.Fail;

// Binds the last `n` arguments of a function where `n` is the length of `args`.
const bindr = function (fn, args) {
    return function () {
        return fn.apply(null, Array.prototype.slice.call(arguments).concat(args));
    };
};

module.exports = function (options) {
    const databaseLocation = options.databaseLocation;
    const isEditorAdmin = options.isEditorAdmin;
    const maxAliasDepth = options.maxAliasDepth;
    const beforeUpdate = options.beforeUpdate;

    if (typeof isEditorAdmin !== "function") {
        throw new Error("isEditorAdmin property must be a function.");
    }

    if (typeof maxAliasDepth !== "number" || maxAliasDepth === Infinity) {
        throw new Error("maxAliasDepth property must be a finite positive integer.");
    }

    if (typeof beforeUpdate !== "function") {
        throw new Error("beforeUpdate property must be a function.");
    }

    const db = Dirty(databaseLocation);

    // (String, Hostmask) -> Result<undefined | %Reply{}, "frozen">
    const getPreviousKeyForEditing = function (key, editor) {
        const previousValue = db.get(key);

        return new Promise(function (resolve, reject) {
            // If there is no previous value, then
            // it cannot be frozen, and thus is editable.
            if (!previousValue) {
                resolve(true)
            // Otherwise, if the key is frozen, then only
            // admins can edit the reply. If the key
            // isn't frozen, it's editable by everybody.
            } else {
                resolve(previousValue.frozen ? isEditorAdmin(editor) : true);
            }
        })
        .then(function (ifCanEdit) {
            return ifCanEdit ? Ok(previousValue) : Fail("frozen");
        });
    };

    const editOnlyWhenPreviousKeyExists = function (description) {
        if (description && description.message) {
            return Ok(description);
        } else {
            return Fail("dne");
        }
    };

    const disallowAtCharacterInKey = function (key) {
        return key.indexOf("@") === -1 ? Ok() : Fail("at-symbol-in-key");
    };

    return {
        // String -> %Tennu.Message{}
        get: function get (key) {
            function getRecursively(key, aliasDepth) {
                if (aliasDepth == maxAliasDepth) {
                    return Fail("max-alias-depth-reached");
                }

                const value = db.get(key.toLowerCase());

                if (!value || !value.message) {
                    return Fail("no-reply");
                }

                if (value.intent === "alias") {
                    return getRecursively(value.message, aliasDepth + 1);
                } else {
                    return Ok({
                        intent: value.intent,
                        message: value.message
                    });
                }
            }

            return getRecursively(key, 0);
        },

        // String, %Reply{} -> Result<%Reply{}, String>
        set: function (key, value) {
            key = key.toLowerCase();

            return Promise.try(function () {
                if (!(value.intent && value.message && value.editor)) {
                    throw new Error("An intent, message, and editor are all needed to set a new reply.");
                }

                return Result.and(
                    disallowAtCharacterInKey(key),
                    getPreviousKeyForEditing(key, value.editor)
                );
            })
            .then(bindr(Result.map, function (previousValue) {
                return {
                    intent: value.intent,
                    message: value.message,
                    editor: value.editor,
                    time: now(),
                    frozen: previousValue ? previousValue.frozen : false
                };
            }))
            .then(bindr(Result.andThen, beforeUpdate))
            .then(bindr(Result.map, function (value) {
                db.set(key, value);

                return value;
            }));
        },

        // String, Hostmask -> Result<(), String>
        delete: function (key, editor) {
            key = key.toLowerCase();

            return getPreviousKeyForEditing(key, editor)
            .then(bindr(Result.andThen, editOnlyWhenPreviousKeyExists))
            .then(bindr(Result.map, function (description) {
                db.set(key, {
                    editor: editor,
                    time: now(),
                    frozen: description.frozen
                });
            }));
        },

        // (String, RegExp, String, HostMask) -> Result<(), String>
        replace: function (key, regexp, replacement, editor) {
            key = key.toLowerCase();

            return getPreviousKeyForEditing(key, editor)
            .then(bindr(Result.andThen, editOnlyWhenPreviousKeyExists))
            .then(bindr(Result.andThen, function (description) {
                const old_message = description.message;
                const new_message = old_message.replace(regexp, replacement);

                if (old_message === new_message) {
                    return Fail("unchanged");
                }

                if (new_message === "") {
                    return Fail("no-message-left");
                }

                description.message = new_message;
                description.editor = editor;
                description.time = now();

                return Ok(description);
            }))
            .then(bindr(Result.andThen, beforeUpdate))
            .then(bindr(Result.map, function (value) {
                db.set(key, value);
                return value;
            }));
        },

        // String -> Boolean
        freeze: function (key) {
            const value = db.get(key);

            if (!value) {
                db.set(key, {
                    frozen: true
                });
                return;
            }

            db.set(key, {
                intent: value.intent,
                message: value.message,
                editor: value.editor,
                time: value.time,
                frozen: true
            });

            return true;
        },

        // String -> Boolean
        unfreeze: function (key) {
            const value = db.get(key);

            if (!value) {
                return false;
            }

            db.set(key, {
                intent: value.intent,
                message: value.message,
                editor: value.editor,
                time: value.time,
                frozen: false
            });

            return true;
        }
    };
};
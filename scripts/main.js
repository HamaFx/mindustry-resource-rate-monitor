// Resource Rate Monitor
// Shows per-resource production/consumption rates and team power stats in the HUD.
//
// Platforms:
// - desktop: replaces the vanilla core item widget inside the "coreinfo" HUD table
// - mobile (Android + iOS): the vanilla core widget is collapsed on mobile, so this
//   mod adds its own table under the wave panel instead
//
// iOS notes:
// - mod.hjson must declare iosCompatible: true (no JavaAdapter / extend() here)
// - iOS runs Rhino interpreted, so keep per-frame work small: the table is only
//   rebuilt when the visible item set, power row or column count changes, and
//   label strings are cached

const SAMPLE_MS = 1000; // rate sampling window
const TICK_MS = 100; // logic refresh
const SHOW_AT = 5; // show a resource once it reaches this amount
const HIDE_AT = 0; // hide it again at or below this amount
const FLICKER_MS = 3000; // reappearing under SHOW_AT within this window means flickering
const COLUMN_OPTIONS = [4, 5, 6, 7, 8];
const HIDDEN_KEY = 'rrm-hidden'; // persisted display toggle
const BUTTON_SIZE = 26; // toggle button hit area, in UI units

let diffs = {}; // item id -> state
let columnIndex = 0;
let visibleCount = 0;
let hidden = false;

let power = { valid: false, produced: 0, demand: 0, net: 0, shortage: false };

let desktopWrapper, desktopContent, desktopCollapser;
let mobileRoot, mobileWrapper, mobileContent, mobileCell;
let lastPadTop = -1, lastPadLeft = -1;

let lastTick = 0;
let lastPowerTick = 0;
let lastSignature = null;
let lastContentWidth = 0;
let useTeamList = true; // v8+ keeps a live building list per team
let usePowerGraphs = true; // v8+ exposes one entry per power network

Events.on(ClientLoadEvent, () => {
    hidden = Core.settings.getBool(HIDDEN_KEY, false);
    reset();
    buildDesktop();
    buildMobile();
});

Events.on(WorldLoadEvent, () => {
    reset();
});

Events.run(Trigger.update, () => {
    const now = Time.millis();
    if (now - lastTick < TICK_MS) return;
    lastTick = now;

    if (!Vars.state.isGame()) return;

    if (!Vars.mobile) {
        tryInjectDesktop();
    } else {
        updateMobileLayout();
        // note: Element.visible is a boolean field, so it is assigned directly
        // instead of using the Boolp overload (which Rhino cannot resolve)
        mobileRoot.visible = Vars.ui.hudfrag.shown && !Vars.state.isMenu() && !Vars.state.isEditor();
    }

    // remember how wide the table is, so the toggle keeps its place when hidden
    if (!hidden && !Vars.mobile && desktopWrapper != null && desktopWrapper.getWidth() > 0) {
        lastContentWidth = desktopWrapper.getWidth();
    }

    if (now - lastPowerTick >= SAMPLE_MS) {
        lastPowerTick = now;
        samplePower();
    }

    const list = sample(now);

    // only rebuild when the displayed content changes; labels update themselves
    const signature = columnIndex + '|' + (hidden ? 'h' : 'v') + '|' + (power.valid ? 'p' : '') + '|'
        + list.map(item => item.id).join(',');

    if (signature != lastSignature) {
        lastSignature = signature;
        render(list);
    }
});

function reset() {
    diffs = {};
    lastSignature = null;
    desktopCollapser = null;
    lastPadTop = -1;
    lastPadLeft = -1;
    lastContentWidth = 0;
    useTeamList = true;
    usePowerGraphs = true;
    power = { valid: false, produced: 0, demand: 0, net: 0, shortage: false };
}

function buildDesktop() {
    desktopWrapper = new Table(Styles.black6);
    desktopWrapper.margin(4);
    desktopWrapper.touchable = Touchable.childrenOnly;

    desktopContent = new Table();
    desktopContent.touchable = Touchable.childrenOnly;
}

function buildMobile() {
    if (mobileRoot != null) return;

    mobileWrapper = new Table(Styles.black6);
    mobileWrapper.margin(4);
    mobileWrapper.touchable = Touchable.childrenOnly;

    mobileContent = new Table();
    mobileContent.touchable = Touchable.childrenOnly;

    mobileRoot = new Table();
    mobileRoot.setFillParent(true);
    mobileRoot.top().left();
    mobileRoot.touchable = Touchable.childrenOnly;
    mobileCell = mobileRoot.add(mobileWrapper).left();

    Vars.ui.hudGroup.addChild(mobileRoot);
}

function tryInjectDesktop() {
    // re-inject if the HUD was rebuilt and our collapser was detached
    if (desktopCollapser != null && desktopCollapser.getScene() == null) desktopCollapser = null;
    if (desktopCollapser != null) return;

    const coreInfo = Vars.ui.hudGroup.find('coreinfo');
    if (coreInfo == null || coreInfo.getChildren().size < 2) return;

    const inner = coreInfo.getChildren().get(1);
    if (inner == null || inner.getChildren().size < 1) return;

    const collapser = inner.getChildren().get(0);
    if (!(collapser instanceof Collapser)) return;

    collapser.setTable(desktopWrapper);
    desktopCollapser = collapser;
}

function updateMobileLayout() {
    if (mobileRoot == null) return;

    // anchor directly under the wave panel: same column, one small gap below it
    // ("waves/editor" is the stack holding the wave panel and the editor panel)
    const stack = Vars.ui.hudGroup.find('waves/editor');

    let padTop, padLeft;
    if (stack != null) {
        const bottom = stack.localToStageCoordinates(Tmp.v1.set(0, 0));
        padTop = Core.scene.getHeight() - bottom.y + Scl.scl(4);
        padLeft = bottom.x;
    } else {
        // fallback for a HUD without the wave stack: keep clear of the mobile button row
        padTop = Core.scene.marginTop + Scl.scl(160);
        padLeft = Scl.scl(4);
    }

    if (Math.abs(padTop - lastPadTop) > 0.5 || Math.abs(padLeft - lastPadLeft) > 0.5) {
        lastPadTop = padTop;
        lastPadLeft = padLeft;
        mobileCell.padTop(padTop).padLeft(padLeft);
        mobileRoot.invalidateHierarchy();
    }
}

function sample(now) {
    const items = Vars.player.team().items();
    const list = [];

    items.each((item, amount) => {
        let d = diffs[item.id];
        if (d == null) {
            d = diffs[item.id] = {
                amount: amount,
                lastAmount: amount,
                lastTime: now,
                rate: 0,
                smoothed: new WindowedMean(4),
                visible: amount >= SHOW_AT,
                flickering: false,
                lastSeenBelow: 0
            };
        }

        d.amount = amount;

        // flicker: a resource that keeps reappearing under the display threshold
        if (amount > 0 && amount < SHOW_AT) {
            if (d.lastSeenBelow > 0 && now - d.lastSeenBelow < FLICKER_MS) {
                d.flickering = true;
            }
            d.lastSeenBelow = now;
        } else if (amount >= SHOW_AT) {
            d.flickering = false;
            d.lastSeenBelow = 0;
        }

        if (d.flickering || amount >= SHOW_AT) {
            d.visible = true;
        } else if (amount <= HIDE_AT) {
            d.visible = false;
        }
        // between HIDE_AT and SHOW_AT keep the previous state, so it does not blink

        // rate in items per second, normalized by the real elapsed time, then smoothed
        // since the sample window can never line up exactly with one second
        const elapsed = now - d.lastTime;
        if (elapsed >= SAMPLE_MS) {
            d.rate = (amount - d.lastAmount) * 1000 / elapsed;
            d.smoothed.add(d.rate);
            d.lastAmount = amount;
            d.lastTime = now;
        }

        if (d.visible) list.push(item);
    });

    visibleCount = list.length;
    return list;
}

// v8 exposes every power network through Groups.powerGraph, and each graph keeps
// its own accounting: getLastScaledPowerIn/Out are per-tick rates for production
// and demand, while getPowerBalance() is a windowed average of the net balance.
// That is the same data the vanilla power bar and Foo's Client display, so the
// numbers here match what the game itself reports.
function samplePowerFromGraphs(teamId, out) {
    let found = false;

    Groups.powerGraph.each(up => {
        // Rhino resolves `graph` to the field, not the getter, so read it directly
        const value = up.graph;
        const graph = (typeof value == 'function') ? up.graph() : value;
        if (graph == null || graph.all.size == 0) return;

        const first = graph.all.first();
        if (first == null || first.team == null || first.team.id != teamId) return;

        found = true;
        out.produced += graph.getLastScaledPowerIn() * 60;
        out.demand += graph.getLastScaledPowerOut() * 60;
        out.net += graph.getPowerBalance() * 60;
        if (graph.getSatisfaction() < 0.999) out.shortage = true;
    });

    return found;
}

// fallback for versions without Groups.powerGraph: sum the team's buildings
function samplePowerFromBuildings(teamId, out) {
    const seen = {};
    let found = false;

    eachTeamBuilding(Vars.player.team(), b => {
        if (b.team == null || b.team.id != teamId) return;

        const module = b.power;
        if (module == null || module.graph == null) return;

        found = true;

        // same per-tick formulas the graph itself uses, so no frame timing is involved
        out.produced += b.getPowerProduction() * 60;

        const consume = b.block.consPower;
        if (consume != null && b.shouldConsumePower) {
            out.demand += consume.requestedPower(b) * 60;
        }

        const graph = module.graph;
        const id = graph.getID();
        if (seen[id] != null) return;
        seen[id] = true;

        out.net += graph.getPowerBalance() * 60;
        if (graph.getSatisfaction() < 0.999) out.shortage = true;
    });

    return found;
}

// v8 keeps a live list of every building per team; older versions need the entity group
function eachTeamBuilding(team, cons) {
    if (useTeamList) {
        try {
            const list = team.data().buildings;
            if (list != null) {
                list.each(cons);
                return;
            }
        } catch (e) {
            useTeamList = false;
        }
    }
    Groups.build.each(cons);
}

// sums the player team's power networks
function samplePower() {
    const teamId = Vars.player.team().id;
    const out = { produced: 0, demand: 0, net: 0, shortage: false };
    let found = false;

    if (usePowerGraphs) {
        try {
            found = samplePowerFromGraphs(teamId, out);
        } catch (e) {
            usePowerGraphs = false;
            out.produced = out.demand = out.net = 0;
            out.shortage = false;
        }
    }

    if (!usePowerGraphs) {
        found = samplePowerFromBuildings(teamId, out);
    }

    power.produced = isFinite(out.produced) ? Math.min(Math.max(out.produced, 0), 1e15) : 1e15;
    power.demand = isFinite(out.demand) ? Math.min(Math.max(out.demand, 0), 1e15) : 1e15;
    power.net = isFinite(out.net) ? Math.max(Math.min(out.net, 1e15), -1e15) : 0;
    power.shortage = out.shortage;
    // hide the row when the team has no power activity at all
    power.valid = found && (power.produced > 0.5 || power.demand > 0.5 || Math.abs(power.net) > 0.5);
}

function render(list) {
    const wrapper = Vars.mobile ? mobileWrapper : desktopWrapper;
    const content = Vars.mobile ? mobileContent : desktopContent;
    if (wrapper == null || content == null) return;

    wrapper.clearChildren();

    // Buttons go on the left, clear of the minimap: the minimap fragment is added
    // after the HUD fragment, so it shadows anything clickable under its corner.
    // Cells are zero-sized unless a size is given, and a zero-sized button can
    // never be hit, so the size is set explicitly.
    // The eye always stays visible, so a hidden table can be brought back.
    wrapper.button(hidden ? Icon.eyeOffSmall : Icon.eyeSmall, Styles.clearNonei, Scl.scl(16), toggleHidden)
        .size(Scl.scl(BUTTON_SIZE)).left().top().padRight(Scl.scl(2));

    if (!hidden) {
        wrapper.button(Icon.list, Styles.clearNonei, Scl.scl(16), cycleColumns)
            .size(Scl.scl(BUTTON_SIZE)).left().top().padRight(Scl.scl(4));

        wrapper.add(content).left();
        fillContent(content, list);
    } else if (!Vars.mobile && lastContentWidth > 0) {
        // the table is centered, so without a placeholder the toggle would jump
        // when the readout is hidden
        wrapper.add().size(Math.max(lastContentWidth - Scl.scl(BUTTON_SIZE), Scl.scl(BUTTON_SIZE)), Scl.scl(BUTTON_SIZE));
    }
}

function fillContent(content, list) {
    content.clearChildren();

    const columns = COLUMN_OPTIONS[columnIndex];
    let i = 0;

    for (let n = 0; n < list.length; n++) {
        const item = list[n];

        content.image(item.uiIcon).left().padRight(2);
        content.label(() => amountText(item.id)).left().padRight(2);
        content.label(() => rateText(item.id)).left().padRight(8);

        if (++i % columns == 0) content.row();
    }

    if (power.valid) {
        if (i % columns != 0) content.row();

        const icon = content.image(Icon.powerSmall).left().padRight(4).get();
        icon.setColor(Pal.powerLight);
        content.label(() => powerText()).left();
    }
}

function toggleHidden() {
    hidden = !hidden;
    Core.settings.put(HIDDEN_KEY, hidden);
    lastSignature = null; // forces a re-render
}

function amountText(id) {
    const d = diffs[id];
    if (d == null) return '';

    const rate = rateOf(d);
    const warn = !d.flickering && rate < 0 && d.amount / -rate <= 10;
    const key = d.amount + '|' + warn;

    // labels call this every frame, so only rebuild the string when something changed
    if (d.amountKey != key) {
        d.amountKey = key;
        d.amountStr = (warn ? '[red](!) [white]' : '') + formatAmount(d.amount);
    }
    return d.amountStr;
}

function rateText(id) {
    const d = diffs[id];
    if (d == null) return '';

    const key = d.flickering ? 'f' : '' + Math.round(rateOf(d));
    if (d.rateKey != key) {
        d.rateKey = key;

        if (d.flickering) {
            d.rateStr = '([yellow]~0[white])';
        } else {
            const rate = Math.round(rateOf(d));
            d.rateStr = rate > 0 ? '([#8585FF]+' + formatAmount(rate) + '[white])'
                : rate < 0 ? '([red]-' + formatAmount(-rate) + '[white])'
                : '([lightgray]0[white])';
        }
    }
    return d.rateStr;
}

function powerText() {
    if (!power.valid) return '';

    const key = power.produced + '|' + power.demand + '|' + power.net + '|' + power.shortage;
    if (key != powerKey) {
        powerKey = key;

        const net = Math.round(power.net);
        const color = net > 0 ? '[#8585FF]' : net < 0 ? '[red]' : '[lightgray]';
        const sign = net > 0 ? '+' : net < 0 ? '-' : '';

        powerStr = (power.shortage ? '[red](!) [white]' : '')
            + formatAmount(power.produced) + '[lightgray]/[white]' + formatAmount(power.demand)
            + ' (' + color + sign + formatAmount(Math.abs(net)) + '[white])';
    }
    return powerStr;
}

let powerKey = '', powerStr = '';

function rateOf(d) {
    return d.smoothed.hasEnoughData() ? d.smoothed.mean() : d.rate;
}

function cycleColumns() {
    const next = (columnIndex + 1) % COLUMN_OPTIONS.length;
    columnIndex = COLUMN_OPTIONS[next] > visibleCount ? 0 : next;
    lastSignature = null;
}

function formatAmount(num) {
    const rounded = Math.round(num);
    if (rounded < 1000) return '' + rounded;

    const units = ['k', 'M', 'B', 'T'];
    let order = 0;
    let value = rounded;

    while (value >= 1000 && order < units.length) {
        value /= 1000;
        order++;
    }

    // note: toFixed() cannot be used here. Mindustry's Rhino rounds to significant
    // digits instead of decimal places, so (14).toFixed(1) is "10.0" and a core
    // holding 14000 items would read "10k". Everything below is integer math on
    // hundredths, which also handles carries like 9.999 turning into "10".
    let scaled = Math.round(value * 100);
    if (scaled >= 100000 && order < units.length) {
        order++;
        scaled = Math.round(scaled / 1000);
    }

    const whole = Math.floor(scaled / 100);
    let text;

    if (whole >= 100) {
        text = '' + Math.round(scaled / 100);
    } else if (whole >= 10) {
        const tenths = Math.round(scaled / 10);
        const head = Math.floor(tenths / 10);
        const tail = tenths - head * 10;
        text = tail === 0 ? '' + head : head + '.' + tail;
    } else {
        const tail = scaled - whole * 100;
        if (tail === 0) text = '' + whole;
        else if (tail % 10 === 0) text = whole + '.' + (tail / 10);
        else text = whole + '.' + (tail < 10 ? '0' + tail : tail);
    }

    return text + units[order - 1];
}


// Resource Rate Monitor
// Shows per-resource production/consumption rates in the core item display.
//
// Platforms:
// - desktop: replaces the vanilla core item widget inside the "coreinfo" HUD table
// - mobile (Android + iOS): the vanilla core widget is collapsed on mobile, so this
//   mod adds its own table under the wave panel instead
//
// iOS notes:
// - mod.hjson must declare iosCompatible: true (no JavaAdapter / extend() here)
// - iOS runs Rhino interpreted, so keep per-frame work small: the table is only
//   rebuilt when the visible item set or column count changes, values update in place

const SAMPLE_MS = 1000; // rate sampling window
const TICK_MS = 100; // logic refresh
const SHOW_AT = 5; // show a resource once it reaches this amount
const HIDE_AT = 0; // hide it again at or below this amount
const FLICKER_MS = 3000; // reappearing under SHOW_AT within this window means flickering
const COLUMN_OPTIONS = [4, 5, 6, 7, 8];

let diffs = {}; // item id -> state
let columnIndex = 0;
let visibleCount = 0;

let desktopWrapper, desktopContent, desktopCollapser;
let mobileRoot, mobileContent, mobileCell;
let lastPadTop = -1, lastPadLeft = -1;

let lastTick = 0;
let lastSignature = null;

Events.on(ClientLoadEvent, () => {
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

    if (!Vars.mobile) tryInjectDesktop();
    if (Vars.mobile) {
        updateMobileLayout();
        // note: Element.visible is a boolean field, so it is assigned directly
        // instead of using the Boolp overload (which Rhino cannot resolve)
        mobileRoot.visible = Vars.ui.hudfrag.shown && !Vars.state.isMenu() && !Vars.state.isEditor();
    }

    const list = sample(now);

    // only rebuild when the item set or column count changes; labels update themselves
    const signature = columnIndex + '|' + list.map(item => item.id).join(',');
    if (signature != lastSignature) {
        lastSignature = signature;
        rebuild(list);
    }
});

function reset() {
    diffs = {};
    lastSignature = null;
    desktopCollapser = null;
    lastPadTop = -1;
    lastPadLeft = -1;
}

function buildDesktop() {
    desktopContent = new Table(Styles.black6);
    desktopContent.margin(4);
    desktopContent.touchable = Touchable.enabled;

    desktopWrapper = new Table();
    desktopWrapper.touchable = Touchable.enabled;
    desktopWrapper.add(desktopContent);
    desktopWrapper.row();
    desktopWrapper.clicked(cycleColumns);
}

function buildMobile() {
    if (mobileRoot != null) return;

    mobileContent = new Table(Styles.black6);
    mobileContent.margin(4);
    mobileContent.touchable = Touchable.enabled;
    mobileContent.clicked(cycleColumns);

    mobileRoot = new Table();
    mobileRoot.setFillParent(true);
    mobileRoot.top().left();
    mobileRoot.touchable = Touchable.childrenOnly;
    mobileCell = mobileRoot.add(mobileContent).left();

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

function rebuild(list) {
    const content = Vars.mobile ? mobileContent : desktopContent;
    if (content == null) return;

    content.clearChildren();

    const columns = COLUMN_OPTIONS[columnIndex];
    let i = 0;

    for (let n = 0; n < list.length; n++) {
        const item = list[n];
        const id = item.id;

        content.image(item.uiIcon).left().padRight(2);
        content.label(() => amountText(id)).left().padRight(2);
        content.label(() => rateText(id)).left().padRight(8);

        if (++i % columns == 0) content.row();
    }
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

function rateOf(d) {
    return d.smoothed.hasEnoughData() ? d.smoothed.mean() : d.rate;
}

function cycleColumns() {
    const next = (columnIndex + 1) % COLUMN_OPTIONS.length;
    columnIndex = COLUMN_OPTIONS[next] > visibleCount ? 0 : next;
    lastSignature = null;
}

function formatAmount(num) {
    if (num < 1000) return Math.round(num).toString();

    const units = ['k', 'M', 'B', 'T'];
    let order = 0;
    let value = num;

    while (value >= 1000 && order < units.length) {
        value /= 1000;
        order++;
    }

    let text = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
    text = text.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');

    return text + units[order - 1];
}

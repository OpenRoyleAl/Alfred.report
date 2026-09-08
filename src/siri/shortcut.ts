import { briefingUrl } from "./tokens";

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildAlfredReportShortcut(token: string): string {
  const url = briefingUrl(token);
  const commentId = crypto.randomUUID().toUpperCase();
  const downloadId = crypto.randomUUID().toUpperCase();
  const playId = crypto.randomUUID().toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowName</key>
  <string>Alfred report</string>
  <key>WFQuickActionSurfaces</key>
  <array/>
  <key>WFWorkflowActions</key>
  <array>
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.comment</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key>
        <string>${commentId}</string>
        <key>WFCommentActionText</key>
        <string>Alfred operational briefing. Token is embedded; GET; no headers.</string>
      </dict>
    </dict>
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.downloadurl</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>Advanced</key>
        <true/>
        <key>ShowHeaders</key>
        <false/>
        <key>UUID</key>
        <string>${downloadId}</string>
        <key>WFHTTPMethod</key>
        <string>GET</string>
        <key>WFURL</key>
        <string>${xmlEscape(url)}</string>
      </dict>
    </dict>
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.playaudio</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key>
        <string>${playId}</string>
        <key>WFInput</key>
        <dict>
          <key>Value</key>
          <dict>
            <key>OutputName</key>
            <string>Contents of URL</string>
            <key>OutputUUID</key>
            <string>${downloadId}</string>
            <key>Type</key>
            <string>ActionOutput</string>
          </dict>
          <key>WFSerializationType</key>
          <string>WFTextTokenAttachment</string>
        </dict>
      </dict>
    </dict>
  </array>
  <key>WFWorkflowClientRelease</key>
  <string>iOS 18.0</string>
  <key>WFWorkflowClientVersion</key>
  <string>3306.0.4</string>
  <key>WFWorkflowHasOutputFallback</key>
  <false/>
  <key>WFWorkflowHasShortcutInputVariables</key>
  <false/>
  <key>WFWorkflowIcon</key>
  <dict>
    <key>WFWorkflowIconGlyphNumber</key>
    <integer>59511</integer>
    <key>WFWorkflowIconStartColor</key>
    <integer>431817727</integer>
  </dict>
  <key>WFWorkflowImportQuestions</key>
  <array/>
  <key>WFWorkflowInputContentItemClasses</key>
  <array/>
  <key>WFWorkflowMinimumClientVersion</key>
  <integer>900</integer>
  <key>WFWorkflowMinimumClientVersionString</key>
  <string>900</string>
  <key>WFWorkflowOutputContentItemClasses</key>
  <array/>
  <key>WFWorkflowTypes</key>
  <array>
    <string>WatchKit</string>
    <string>NCWidget</string>
  </array>
</dict>
</plist>
`;
}

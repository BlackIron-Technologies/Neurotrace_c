import * as vscode from 'vscode';
import { PythonServerManager } from './PythonServerManager';

export class ThoughtGraphPanel {
  private panel?: vscode.WebviewPanel;
  private showSemantic = false;
  private isRefresh = false;

  constructor(private ctx: vscode.ExtensionContext,
    private server: PythonServerManager) { }

  public forceRefresh() {
    if (this.panel) {
      this.panel.webview.postMessage({ type: 'clear-cache' });
      this.initData();
      this.loadInsights();
    }
  }

  public show() {
    if (this.panel) { this.panel.reveal(); return; }

    this.panel = vscode.window.createWebviewPanel(
      'neurotrace.graph',
      'Thought Graph',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => (this.panel = undefined));
    this.panel.webview.html = this.html();

    this.initData();
    this.loadInsights();

    this.panel.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'open':
          vscode.commands.executeCommand('neurotrace.openThought', msg.id);
          break;
        case 'toggle-semantic':
          this.showSemantic = !this.showSemantic;
          await this.initData();
          break;
        case 'create-link':
          await this.server.sendCommand('add-relation', {
            src: msg.src,
            dst: msg.dst,
            rel: msg.rel
          });
          await this.initData();
          break;
        case 'delete-link':
          if (msg.id) {
            await this.server.sendCommand('delete-relation', { id: msg.id });
            await this.initData();
          }
          break;
        case 'load-insights':
          this.loadInsights();
          break;
        case 'refresh-graph':
          this.isRefresh = true;
          await this.initData();
          this.loadInsights();
          this.isRefresh = false;
          break;
        case 'force-refresh':
          // Force complete refresh, ignore cache
          this.panel?.webview.postMessage({ type: 'clear-cache' });
          await this.initData();
          this.loadInsights();
          break;
        case 'save-layout':
          await this.server.sendCommand('save-graph-layout', msg.payload);
          break;
        case 'retip-edge':
          vscode.commands.executeCommand('neurotrace.retipEdge', msg.id);
          break;
        case 'get-layout':
          this.loadSavedLayout();
          break;
      }
    });
  }

  private async initData() {
    try {
      const buildResult = await this.server.sendCommand('build_index');
      console.log('FAISS index build result:', buildResult);
    } catch (error) {
      console.warn('Failed to build FAISS index, continuing anyway:', error);
    }

    try {
      const data = await this.server.sendCommand<any>('graph-data');

      if (!this.showSemantic && data && data.edges) {
        data.edges = data.edges.filter((edge: any) => edge.rel !== 'semantic');
      }

      this.panel?.webview.postMessage({ type: 'data', payload: data, force: this.isRefresh });
    } catch (error) {
      console.error('Failed to load graph data:', error);
      this.panel?.webview.postMessage({ type: 'data', payload: { nodes: [], edges: [] }, force: this.isRefresh });
    }
  }

  private async loadInsights() {
    try {
      const ins = await this.server.sendCommand<any>('graph-insights');
      this.panel?.webview.postMessage({ type: 'insights', payload: ins });
    } catch (error) {
      console.error('Failed to load insights:', error);
      this.panel?.webview.postMessage({ type: 'insights', payload: { error: (error as Error).message } });
    }
  }

  private async loadSavedLayout() {
    try {
      const layoutData = await this.server.sendCommand<any>('get-graph-layout');
      this.panel?.webview.postMessage({ type: 'layout-data', payload: layoutData });
    } catch (error) {
      console.error('Error loading graph layout:', error);
    }
  }

  private html(): string {
    if (!this.panel) {
      return '';
    }

    // Generate secure URIs for local resources
    const cyUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'cytoscape.min.js')
    );
    const colaUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'cytoscape-cola.js')
    );

    return /* html */`
<!DOCTYPE html><html><head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' ${this.panel.webview.cspSource} 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self';"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Thought Graph</title>
<style>
:root {
  --primary-color: #7c8dff;
  --primary-hover: #6b7cee;
  --secondary-color: #1e1e1e;
  --background-dark: rgba(14, 14, 14, 0.94);
  --background-medium: rgba(22, 22, 22, 0.9);
  --text-primary: #e0e0e0;
  --text-secondary: #999;
  --border-color: rgba(255, 255, 255, 0.06);
  --shadow-strong: 0 4px 20px rgba(0, 0, 0, 0.5);
  --shadow-medium: 0 2px 10px rgba(0, 0, 0, 0.3);
  --border-radius: 6px;
  --transition-smooth: all 0.25s ease;
  --node-decision: #e05565;
  --node-hypothesis: #e0a050;
  --node-insight: #50b0e0;
  --node-task: #65c065;
  --node-risk: #ff8a65;
  --node-discard: #888;
  --node-note: #aaa;
}

html,body{
  height:100%;margin:0;padding:0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  overflow:hidden;
  background: #0d0d0d;
}

#cy{
  height:100%;width:100%;position:absolute;top:0;left:0;
  background: transparent;
}

#toolbar{
  position:absolute;top:20px;left:20px;z-index:20;
  background: var(--background-dark);
  border: 1px solid var(--border-color);
  padding:8px 12px;border-radius:var(--border-radius);
  box-shadow: var(--shadow-medium);
  display: flex;
  gap: 6px;
  align-items: center;
}

#toolbar button{
  background: var(--secondary-color);
  color: var(--text-primary);
  border:none;
  padding:8px 12px;
  border-radius:5px;
  cursor:pointer;
  transition: var(--transition-smooth);
  font-weight: 500;
  font-size: 12px;
  letter-spacing: 0.2px;
  display: flex;
  align-items: center;
  gap: 4px;
  position: relative;
  overflow: hidden;
}

#toolbar button:hover{
  background: var(--primary-color);
  box-shadow: none;
}

#toolbar button.active{
  background: var(--primary-color);
  box-shadow: 0 0 20px rgba(0, 120, 212, 0.4);
}

#insights{
  position:absolute;right:0;top:0;width:300px;height:100%;
  background: var(--background-dark);
  border-left: 1px solid var(--border-color);
  color: var(--text-primary);
  overflow:auto;font-size:13px;z-index:10;
  padding:20px;box-sizing:border-box;
  transform:translateX(100%);
  transition: var(--transition-smooth);
}

#insights.visible{transform:translateX(0)}

#insights h3{
  margin-top:0;font-size:16px;font-weight:600;
  color: var(--text-primary);
  border-bottom:1px solid var(--border-color);
  padding-bottom:10px;
  margin-bottom: 18px;
}

#insights .section{
  margin-bottom:16px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: var(--border-radius);
  border: 1px solid var(--border-color);
}

#insights .section-title{
  font-weight:600;margin-bottom:10px;
  color: var(--primary-color);
  font-size: 13px;
}

#legend{
  position:absolute;bottom:20px;left:20px;z-index:20;
  background: var(--background-dark);
  border: 1px solid var(--border-color);
  padding:10px 14px;border-radius:var(--border-radius);
  box-shadow: var(--shadow-medium);
  color: var(--text-secondary);
  font-size:10px;max-width:240px;
}

#legend h3{
  margin-top:0;font-size:12px;margin-bottom:8px;font-weight:600;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 4px;
}

.legend-item{
  display:flex;align-items:center;margin-bottom:3px;
  padding: 2px 0;
}

.color-box{
  width:8px;height:8px;margin-right:8px;
  border-radius:50%;border:none;
  flex-shrink:0;
}

.color-box.edge-style{
  width:16px;height:2px;
  border-radius:1px;
}

.legend-section{
  margin-bottom:8px;
}

.legend-section h4{
  margin:0 0 4px 0;font-size:10px;font-weight:600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.cy-tooltip {
  position: absolute;
  background: var(--background-dark);
  color: var(--text-primary);
  padding: 10px 14px;
  border-radius: var(--border-radius);
  font-size: 11px;
  font-weight: 400;
  box-shadow: var(--shadow-strong);
  max-width: 300px;
  z-index: 30;
  pointer-events: none;
  border: 1px solid var(--border-color);
}

.cy-tooltip .tooltip-title {
  font-weight: 600;
  color: var(--primary-color);
  font-size: 12px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 4px;
}

.cy-tooltip .tooltip-content {
  line-height: 1.5;
  word-wrap: break-word;
  margin-bottom: 8px;
  max-height: 140px;
  overflow-y: auto;
  color: var(--text-secondary);
  font-size: 11px;
}

.cy-tooltip .tooltip-content::-webkit-scrollbar {
  width: 3px;
}

.cy-tooltip .tooltip-content::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 2px;
}

.cy-tooltip .tooltip-content::-webkit-scrollbar-thumb {
  background: var(--primary-color);
  border-radius: 2px;
}

.cy-tooltip .tooltip-meta {
  font-size: 10px;
  color: var(--text-secondary);
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
  display: grid;
  gap: 3px;
}

.cy-tooltip .tooltip-meta strong {
  color: var(--primary-color);
  font-weight: 600;
}

#search-panel{
  position:absolute;top:80px;left:20px;z-index:20;
  background: var(--background-dark);
  border: 1px solid var(--border-color);
  padding:6px 8px;border-radius:var(--border-radius);
  display:flex;align-items:center;gap:6px;
  box-shadow: var(--shadow-medium);
}

#search-panel:focus-within {
  border-color: var(--primary-color);
}

#search-input{
  padding:8px 12px;border:none;
  border-radius:5px;width:220px;
  background: var(--secondary-color);
  color: var(--text-primary);
  font-size:13px;
  transition: var(--transition-smooth);
  outline: none;
}

#search-input::placeholder {
  color: var(--text-secondary);
  opacity: 0.8;
}

#search-input:focus {
  background: rgba(255, 255, 255, 0.1);
}

#search-button{
  background: var(--primary-color);
  color: var(--text-primary);
  border:none;border-radius:5px;
  padding:8px 12px;cursor:pointer;
  font-size:13px;
  transition: var(--transition-smooth);
  display: flex;
  align-items: center;
  justify-content: center;
}

#search-button:hover{
  background: var(--primary-hover);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 120, 212, 0.3);
}

#toggle-insights{
  position:absolute;top:20px;right:20px;z-index:21;
  background: var(--secondary-color);
  color: var(--text-primary);
  border:1px solid var(--border-color);border-radius:50%;
  width:36px;height:36px;font-size:14px;
  cursor:pointer;
  transition: var(--transition-smooth);
  display: flex;
  align-items: center;
  justify-content: center;
}

#toggle-insights:hover{
  background: var(--primary-color);
  border-color: var(--primary-color);
}

#refresh-graph{
  position:absolute;top:66px;right:20px;z-index:21;
  background: var(--secondary-color);
  color: var(--text-primary);
  border:1px solid var(--border-color);border-radius:50%;
  width:42px;height:42px;font-size:16px;
  cursor:pointer;
  transition: var(--transition-smooth);
  box-shadow: var(--shadow-medium);
  display: flex;
  align-items: center;
  justify-content: center;
}

#refresh-graph:hover{
  background: var(--primary-color);
  border-color: var(--primary-color);
  transform: rotate(180deg);
}

/* Estilos para modo de enlace manual */
.can-link {
  border-color: var(--primary-color) !important;
  border-width: 3px !important;
  cursor: crosshair !important;
  box-shadow: 0 0 20px rgba(0, 120, 212, 0.5) !important;
  animation: pulse-glow 2s infinite;
}

@keyframes pulse-glow {
  0%, 100% { 
    box-shadow: 0 0 20px rgba(0, 120, 212, 0.3);
    transform: scale(1);
  }
  50% { 
    box-shadow: 0 0 30px rgba(0, 120, 212, 0.6);
    transform: scale(1.02);
  }
}

.preview-edge {
  line-style: dashed;
  line-color: var(--primary-color);
  opacity: 0.8;
  target-arrow-shape: triangle;
  target-arrow-color: var(--primary-color);
  curve-style: bezier;
  width: 3;
  line-dash-pattern: [8, 4];
  animation: dash-flow 1s linear infinite;
}

@keyframes dash-flow {
  0% { line-dash-offset: 0; }
  100% { line-dash-offset: 12; }
}

.edge-created-notification {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--background-dark);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: 12px 20px;
  border-radius: var(--border-radius);
  font-size: 12px;
  font-weight: 500;
  z-index: 1000;
  box-shadow: var(--shadow-strong);
  animation: slideUp 0.4s ease-out;
}

@keyframes slideUp {
  from {
    transform: translateX(-50%) translateY(100px);
    opacity: 0;
  }
  to {
    transform: translateX(-50%) translateY(0);
    opacity: 1;
  }
}

.relation-type-menu {
  position: absolute;
  z-index: 1000;
  background: var(--vscode-dropdown-background, #2d2d2d);
  border: 1px solid var(--vscode-dropdown-border, #555);
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  padding: 5px 0;
  min-width: 120px;
}

.relation-type-menu div {
  padding: 8px 12px;
  cursor: pointer;
  color: var(--vscode-foreground, #fff);
  font-size: 14px;
  border-bottom: 1px solid rgba(255,255,255,0.1);
}

.relation-type-menu div:hover {
  background-color: var(--vscode-list-hoverBackground, #444);
}

/* Modo de alta legibilidad */
.readable-mode .cy-tooltip {
  font-size: 16px;
  max-width: 450px;
  line-height: 1.8;
}

.readable-mode node {
  font-size: 16px !important;
  font-weight: bold !important;
  text-outline-width: 4px !important;
  text-background-padding: 8px !important;
}

/* Efectos de carga y transiciones */
@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.8); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes slideInLeft {
  from { transform: translateX(-100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

@keyframes slideInUp {
  from { transform: translateY(50px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

#toolbar {
  animation: slideInUp 0.6s ease-out;
}

#legend {
  animation: slideInLeft 0.8s ease-out 0.2s both;
}

#search-panel {
  animation: slideInUp 0.6s ease-out 0.1s both;
}

#toggle-insights, #refresh-graph {
  animation: fadeIn 0.6s ease-out 0.3s both;
}

/* Scrollbar personalizada para insights */
#insights::-webkit-scrollbar {
  width: 8px;
}

#insights::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
}

#insights::-webkit-scrollbar-thumb {
  background: linear-gradient(135deg, var(--primary-color), #40a9ff);
  border-radius: 4px;
}

#insights::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(135deg, var(--primary-hover), #1890ff);
}

/* Mejoras de accesibilidad */
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* Modal de ayuda */
#help-modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(8px);
  z-index: 1000;
  display: none;
  align-items: center;
  justify-content: center;
  animation: fadeIn 0.3s ease-out;
}

#help-modal.visible {
  display: flex;
}

.help-content {
  background: var(--background-dark);
  backdrop-filter: blur(20px);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 32px;
  max-width: 600px;
  max-height: 80vh;
  overflow-y: auto;
  box-shadow: var(--shadow-strong);
  color: var(--text-primary);
  position: relative;
  animation: slideInUp 0.4s ease-out;
}

.help-content h2 {
  margin: 0 0 24px 0;
  font-size: 24px;
  font-weight: 700;
  background: linear-gradient(135deg, var(--primary-color), #40a9ff);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  display: flex;
  align-items: center;
  gap: 12px;
}

.help-content h2::before {
  content: '🚀';
  font-size: 28px;
  background: none;
  -webkit-text-fill-color: currentColor;
}

.help-section {
  margin-bottom: 24px;
  padding: 20px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  border-left: 4px solid var(--primary-color);
}

.help-section h3 {
  margin: 0 0 16px 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--primary-color);
  display: flex;
  align-items: center;
  gap: 8px;
}

.help-section p {
  margin: 0 0 12px 0;
  line-height: 1.6;
  color: var(--text-secondary);
}

.help-section ul {
  margin: 0;
  padding-left: 20px;
}

.help-section li {
  margin-bottom: 8px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.help-section .shortcut {
  background: var(--secondary-color);
  padding: 2px 8px;
  border-radius: 4px;
  font-family: 'Courier New', monospace;
  font-weight: 600;
  color: var(--primary-color);
  border: 1px solid var(--border-color);
}

.help-close {
  position: absolute;
  top: 16px;
  right: 16px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 24px;
  cursor: pointer;
  padding: 8px;
  border-radius: 50%;
  transition: var(--transition-smooth);
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.help-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.help-tip {
  background: rgba(0, 120, 212, 0.1);
  border: 1px solid rgba(0, 120, 212, 0.3);
  border-radius: 8px;
  padding: 16px;
  margin-top: 16px;
}

.help-tip::before {
  content: '💡 ';
  font-size: 16px;
}

.help-tip p {
  margin: 0;
  color: var(--text-primary);
  font-weight: 500;
}

/* Scrollbar para el modal de ayuda */
.help-content::-webkit-scrollbar {
  width: 8px;
}

.help-content::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
}

.help-content::-webkit-scrollbar-thumb {
  background: linear-gradient(135deg, var(--primary-color), #40a9ff);
  border-radius: 4px;
}

/* Responsive design para pantallas pequeñas */
@media (max-width: 1200px) {
  #insights {
    width: 280px;
  }
  
  #toolbar {
    flex-wrap: wrap;
    gap: 6px;
  }
  
  #toolbar button {
    padding: 6px 10px;
    font-size: 11px;
  }
}

@media (max-width: 768px) {
  #insights {
    width: 100%;
    height: 40%;
    top: auto;
    bottom: 0;
    transform: translateY(100%);
  }
  
  #insights.visible {
    transform: translateY(0);
  }
  
  #legend {
    position: fixed;
    bottom: 10px;
    left: 10px;
    max-width: 240px;
    font-size: 10px;
    padding: 8px 12px;
  }
  
  #toolbar {
    top: 10px;
    left: 10px;
    right: 10px;
    width: auto;
  }
}


/* Zoom Slider Control */
#zoom-control {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--background-dark);
  backdrop-filter: blur(20px);
  border: 1px solid var(--border-color);
  border-radius: 24px;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  gap: 16px;
  box-shadow: var(--shadow-strong);
  z-index: 20;
  transition: var(--transition-smooth);
}

#zoom-control:hover {
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

#zoom-control .zoom-icon {
  font-size: 18px;
  user-select: none;
  opacity: 0.7;
  transition: opacity 0.2s;
}

#zoom-control .zoom-icon:hover {
  opacity: 1;
  cursor: pointer;
}

#zoom-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 200px;
  height: 6px;
  background: linear-gradient(90deg, 
    rgba(64, 169, 255, 0.2) 0%, 
    rgba(64, 169, 255, 0.4) 50%, 
    rgba(64, 169, 255, 0.2) 100%);
  border-radius: 3px;
  outline: none;
  transition: all 0.2s;
}

#zoom-slider:hover {
  background: linear-gradient(90deg, 
    rgba(64, 169, 255, 0.3) 0%, 
    rgba(64, 169, 255, 0.5) 50%, 
    rgba(64, 169, 255, 0.3) 100%);
}

#zoom-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 20px;
  height: 20px;
  background: linear-gradient(135deg, var(--primary-color), #40a9ff);
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 2px 8px rgba(64, 169, 255, 0.4);
}

#zoom-slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
  box-shadow: 0 4px 16px rgba(64, 169, 255, 0.6);
}

#zoom-slider::-webkit-slider-thumb:active {
  transform: scale(1.1);
}

#zoom-slider::-moz-range-thumb {
  width: 20px;
  height: 20px;
  background: linear-gradient(135deg, var(--primary-color), #40a9ff);
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 2px 8px rgba(64, 169, 255, 0.4);
}

#zoom-slider::-moz-range-thumb:hover {
  transform: scale(1.2);
  box-shadow: 0 4px 16px rgba(64, 169, 255, 0.6);
}

#zoom-slider::-moz-range-thumb:active {
  transform: scale(1.1);
}

#zoom-level {
  font-size: 12px;
  font-weight: 600;
  color: var(--primary-color);
  min-width: 45px;
  text-align: center;
  user-select: none;
}

@media (max-width: 768px) {
  #zoom-control {
    bottom: 80px;
    padding: 10px 16px;
  }
  
  #zoom-slider {
    width: 140px;
  }
}
</style>
</head><body>
<!-- Enhanced Toolbar with Modern Design -->
<div id="toolbar">
  <button id="btn-sem" title="Show/hide semantic relationships">
    <span>🧠</span> Semantic AI
  </button>
  <button id="btn-recenter" title="Recenter graph">
    <span>🎯</span> Center
  </button>
  <button id="btn-link" title="Mode for creating manual connections">
    <span>🔗</span> Link
  </button>
  <button id="btn-filter" title="Filter by type">
    <span>🔍</span> Filter
  </button>
  <button id="btn-save" title="Save current layout">
    <span>💾</span> Save
  </button>
  <button id="btn-zoom-fit" title="Auto-fit zoom for optimal readability">
    <span>🔍</span> Auto Zoom
  </button>
  <button id="btn-readable" title="Toggle high readability mode">
    <span>📖</span> Read
  </button>
  <button id="btn-help" title="Show usage guide">
    <span>❓</span> Help
  </button>
</div>

<!-- Search Panel -->
<div id="search-panel">
  <input id="search-input" type="text" placeholder="Search thoughts...">
  <button id="search-button">🔍</button>
</div>

<!-- Toggle Insights Button -->
<button id="toggle-insights">≡</button>

<!-- Refresh Button -->
<button id="refresh-graph" title="Refresh graph">🔄</button>

<!-- Insights Side Panel -->
<div id="insights">
  <h3>Graph Analysis</h3>
  <div id="insights-content"></div>
</div>

<!-- Modern Color Legend -->

<!-- Contenedor del gráfico -->
<div id="cy"></div>

<!-- Zoom Control Slider -->
<div id="zoom-control">
  <span class="zoom-icon" id="zoom-out">🔍−</span>
  <input type="range" id="zoom-slider" min="0.25" max="3" step="0.05" value="1">
  <span class="zoom-icon" id="zoom-in">🔍+</span>
  <span id="zoom-level">100%</span>
</div>

<!-- Scripts -->
<script src="${cyUri}"></script>
<script src="${colaUri}"></script>
<script>
const vscode = acquireVsCodeApi();
let cy, linkMode = false;
let searchHighlight = null;
let filteredType = null;
let layoutLoaded = false;
let startNode = null;
let previewEdge = null;
let lastNodes = [];
let lastEdges = [];

// Register cola explicitly
if (typeof cytoscape !== 'undefined' && typeof cytoscapeCola !== 'undefined') {
    cytoscape.use(cytoscapeCola);
} else {
    console.error("Failed to register plugins: libraries not loaded");
}

// Handle messages from extension
window.addEventListener('message', ev => {
  const {type, payload, force = false} = ev.data;
  if (type === 'data') draw(payload, force);
  if (type === 'insights') {
    // Wait for cy to be initialized
    if (cy) {
      showInsights(payload);
    } else {
      // Retry after a short delay
      setTimeout(() => showInsights(payload), 500);
    }
  }
  if (type === 'layout-data') applyLayout(payload);
  if (type === 'clear-cache') {
    lastNodes = [];
    lastEdges = [];
  }
});

// Shows graph analysis data with fallback
function showInsights(payload) {
  const insightsEl = document.getElementById('insights-content');
  
  if (!payload) {
    insightsEl.innerHTML = '<p>No insights data received.</p>';
    return;
  }
  
  if (payload.error) {
    insightsEl.innerHTML = '<p>Error: ' + payload.error + '</p>';
    return;
  }
  
  if (!payload || Object.keys(payload).length === 0) {
    insightsEl.innerHTML = '<p>No insights available. Check graph data or install networkx in Python environment.</p>';
    return;
  }
  
  let html = '<div class="section">';
  html += '<div class="section-title">Isolated Nodes</div>';
  
  if (payload.isolated && payload.isolated.length) {
    html += payload.isolated.length + ' nodes without connections';
  } else {
    html += 'None - All nodes are connected!';
  }
  html += '</div>';
  
  html += '<div class="section">';
  html += '<div class="section-title">Central Nodes (Hubs)</div>';
  if (payload.hubs && payload.hubs.length) {
    payload.hubs.forEach(id => {
      const node = cy ? cy.getElementById(id) : null;
      const label = node && node.length > 0 ? node.data('label') : id.substring(0, 8);
      const connections = node && node.length > 0 ? node.connectedEdges().length : '?';
      html += \`<div class="hub-item" data-id="\${id}">\${label} (\${connections} connections)</div>\`;
    });
  } else {
    html += 'No hubs found';
  }
  html += '</div>';
  
  html += '<div class="section">';
  html += '<div class="section-title">Communities</div>';
  html += \`\${payload.communities ? payload.communities.length : 0} groups of related thoughts\`;
  html += '</div>';
  
  insightsEl.innerHTML = html;
  
  if (cy) {
    document.querySelectorAll('.hub-item').forEach(el => {
      el.style.cursor = 'pointer';
      el.style.textDecoration = 'underline';
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-id');
        const node = cy.getElementById(id);
        if (node.length > 0) {
          cy.animate({
            center: { eles: node },
            zoom: 0.7,
            duration: 500
          });
          pulseNode(node);
        }
      });
    });
  }
}

// Visual effect to highlight a node
function pulseNode(node) {
  const originalWidth = node.style('width');
  const originalHeight = node.style('height');
  
  node.animate({
    style: { 
      width: parseInt(originalWidth) * 1.5,
      height: parseInt(originalHeight) * 1.5,
      borderWidth: 4,
      borderColor: '#fff',
      borderOpacity: 1
    },
    duration: 300
  }).animate({
    style: {
      width: originalWidth,
      height: originalHeight,
      borderWidth: 0
    },
    duration: 300
  });
}

// Show notification (used for both success and error)
function showNotification(message, isError = false) {
  const notification = document.createElement('div');
  notification.className = 'edge-created-notification';
  notification.textContent = message;
  notification.style.backgroundColor = isError ? 'rgba(220,53,69,0.8)' : 'rgba(0,120,212,0.8)';
  document.body.appendChild(notification);
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => {
      if (document.body.contains(notification)) {
        document.body.removeChild(notification);
      }
    }, 500);
  }, 3000);
}

// Generic confirmation dialog
function showConfirm(message, onYes, onNo) {
  const dialog = document.createElement('div');
  dialog.style.position = 'fixed';
  dialog.style.top = '50%';
  dialog.style.left = '50%';
  dialog.style.transform = 'translate(-50%, -50%)';
  dialog.style.background = '#222';
  dialog.style.color = '#fff';
  dialog.style.padding = '20px';
  dialog.style.borderRadius = '8px';
  dialog.style.zIndex = '2000';
  dialog.innerHTML = '<div style="margin-bottom:12px">' + message + '</div>' +
    '<button id="yesBtn" style="margin-right:10px">Yes</button>' +
    '<button id="noBtn">No</button>';
  document.body.appendChild(dialog);

  dialog.querySelector('#yesBtn').onclick = () => {
    document.body.removeChild(dialog);
    onYes();
  };
  dialog.querySelector('#noBtn').onclick = () => {
    document.body.removeChild(dialog);
    if (onNo) onNo();
  };
}

// Draw function - Fixed to eliminate flashing
function draw(payload, force = false) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const edges = Array.isArray(payload?.edges) ? payload.edges : [];

  const nodesStr = JSON.stringify(nodes);
  const edgesStr = JSON.stringify(edges);
  if (!force && nodesStr === lastNodes && edgesStr === lastEdges) {
    return;
  }
  lastNodes = nodesStr;
  lastEdges = edgesStr;

  const container = document.getElementById('cy');
  if (!cy && !container) {
    console.warn('Graph container #cy not ready, deferring draw');
    setTimeout(() => draw(payload, force), 50);
    return;
  }

  const elems = [];
  const nodeIds = new Set();
  nodes.forEach(n => {
    if (n && n.id != null) {
      nodeIds.add(String(n.id));
      const nodeData = { ...n, weight: n.weight != null ? n.weight : 1 };
      elems.push({ data: nodeData });
    }
  });
  edges.forEach(e => {
    if (e && e.source != null && e.target != null && nodeIds.has(String(e.source)) && nodeIds.has(String(e.target))) {
      elems.push({ data: e });
    }
  });

  if (!cy) {
    // Initialize cytoscape
    try {
      if (typeof cytoscape !== 'function') {
        showNotification("Failed to initialize graph (Cytoscape not loaded)", true);
        return;
      }
      cy = cytoscape({
        container: container,
        elements: elems,
        style: [
          {selector: 'node', style: {
            'label': 'data(label)',
            'text-wrap': 'wrap',
            'text-max-width': '100px',
            'font-size': '10px',
            'font-weight': '400',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 3,
            'background-color': '#8a8ac0',
            'background-opacity': 0.85,
            'color': 'rgba(255, 255, 255, 0.75)',
            'text-opacity': 0,
            'width': 'mapData(weight, 1, 10, 4, 14)',
            'height': 'mapData(weight, 1, 10, 4, 14)',
            'border-width': 0,
            'overlay-opacity': 0,
            'overlay-padding': 0,
            'transition-property': 'background-color, width, height, text-opacity, border-width, border-color, overlay-opacity, opacity',
            'transition-duration': '0.2s'
          }},
          {selector: 'node#dummy', style: {
            'opacity': 0
          }},
          {selector: 'node[type="discard"]', style: {
            'background-color': '#666',
            'background-opacity': 0.5
          }},
          {selector: 'node[type="risk"]', style: {
            'background-color': '#ff8a65',
            'background-opacity': 0.9
          }},
          {selector: 'node.search-match', style: {
            'background-color': '#ffffff',
            'background-opacity': 1,
            'text-opacity': 1,
            'width': 'mapData(weight, 1, 10, 7, 18)',
            'height': 'mapData(weight, 1, 10, 7, 18)'
          }},
          {selector: 'node:hover', style: {
            'text-opacity': 1,
            'background-opacity': 1,
            'width': 'mapData(weight, 1, 10, 7, 20)',
            'height': 'mapData(weight, 1, 10, 7, 20)'
          }},
          {selector: 'edge', style: {
            'width': 0.5,
            'line-color': 'rgba(255, 255, 255, 0.08)',
            'curve-style': 'bezier',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': 'rgba(255, 255, 255, 0.08)',
            'arrow-scale': 0.5,
            'opacity': 0.35,
            'line-cap': 'round',
            'transition-property': 'line-color, width, opacity, target-arrow-color',
            'transition-duration': '0.15s'
          }},
          {selector: 'edge:hover', style: {
            'width': 1.5,
            'opacity': 1,
            'line-color': 'rgba(255, 255, 255, 0.5)',
            'target-arrow-color': 'rgba(255, 255, 255, 0.5)'
          }},
          {selector: 'edge[rel="semantic"]', style: {
            'line-style': 'dotted',
            'line-dash-pattern': [4, 4],
            'opacity': 0.15,
            'line-color': 'rgba(255, 255, 255, 0.08)',
            'width': 0.4
          }},
          {selector: 'edge[rel="file"]', style: {
            'line-color': 'rgba(80, 160, 220, 0.12)',
            'width': 0.5
          }},
          {selector: 'edge[rel="next"]', style: {
            'line-color': 'rgba(255, 255, 255, 0.06)',
            'line-style': 'dashed',
            'line-dash-pattern': [6, 5],
            'width': 0.4
          }},
          {selector: 'edge[rel="manual"]', style: {
            'line-color': 'rgba(200, 170, 80, 0.2)',
            'width': 1,
            'target-arrow-color': 'rgba(200, 170, 80, 0.2)',
            'opacity': 0.4
          }},
          {selector: 'edge.preview', style: {
            'line-style': 'dashed',
            'line-color': '#7c8dff',
            'opacity': 0.6,
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#7c8dff',
            'curve-style': 'bezier'
          }},
          {selector: '.dimmed', style: {
            'opacity': 0.08,
            'transition-duration': '0.15s'
          }},
          {selector: 'node.highlighted', style: {
            'opacity': 1,
            'text-opacity': 1,
            'background-opacity': 1,
            'transition-duration': '0.15s'
          }},
          {selector: 'edge.highlighted-edge', style: {
            'opacity': 0.8,
            'width': 1.5,
            'line-color': 'rgba(255, 255, 255, 0.35)',
            'target-arrow-color': 'rgba(255, 255, 255, 0.35)',
            'transition-duration': '0.15s'
          }}
        ]
      });
    } catch (e) {
      const msg = e && (e.message || String(e));
      console.error("Failed to initialize Cytoscape:", e);
      showNotification("Failed to initialize graph: " + (msg || "unknown error"), true);
      return;
    }

    // Set up event handlers after graph initialization
    setupCytoscapeEvents();
    
    // Request saved layout first
    console.log('Requesting saved layout');
    vscode.postMessage({ type: 'get-layout' });
  } else {
    // For existing graph, preserve node positions
    const positions = {};
    cy.nodes().forEach(node => {
      positions[node.id()] = {
        x: node.position('x'),
        y: node.position('y')
      };
    });
    
    // Update elements
    cy.edges().remove();
    edges.forEach(e => cy.add({ data: e }));
    
    // Find new nodes
    const existingNodeIds = cy.nodes().map(n => n.id());
    const newNodes = nodes.filter(n => !existingNodeIds.includes(n.id));
    if (newNodes.length > 0) {
      cy.add(newNodes.map(n => ({ data: n })));
      
      // Only lay out new nodes
      cy.nodes().filter(n => newNodes.some(nn => nn.id === n.id())).layout({
        name: 'grid',
        animate: false
      }).run();
    }
    
    // Restore positions of existing nodes
    Object.keys(positions).forEach(id => {
      const node = cy.getElementById(id);
      if (node.length > 0) {
        node.position(positions[id]);
      }
    });
    
    // Update node weights based on connections
    cy.nodes().forEach(node => {
      const connections = node.connectedEdges().length;
      node.data('weight', Math.min(Math.max(connections, 1), 10));
    });
    
    // Auto-adjust zoom for optimal readability
    setTimeout(() => {
      if (cy) {
        const nodeCount = cy.nodes().length;
        let optimalZoom = 1.0;
        
        if (nodeCount <= 5) {
          optimalZoom = 0.6;
        } else if (nodeCount <= 15) {
          optimalZoom = 0.4;
        } else if (nodeCount <= 30) {
          optimalZoom = 0.2;
        } else if (nodeCount <= 50) {
          optimalZoom = 0.1;
        } else {
          optimalZoom = Math.max(0.1, 30 / nodeCount);
        }
        
        cy.animate({
          fit: {
            eles: cy.nodes(),
            padding: 50
          },
          zoom: optimalZoom
        }, {
          duration: 600,
          easing: 'ease-out'
        });
      }
    }, 100);
  }
}

// Setup Cytoscape events
function setupCytoscapeEvents() {
  cy.on('tap', 'node', function(evt) {
    if (linkMode) return;
    
    const node = evt.target;
    vscode.postMessage({
      type: 'open', 
      id: node.id()
    });

    cy.animate({
      center: { eles: node.neighborhood().add(node) },
      zoom: Math.min(cy.zoom() * 1.2, 1.8),
      duration: 350,
      easing: 'ease-out'
    });
  });

  cy.on('tap', function(evt) {
    if (evt.target === cy) {
      cy.animate({
        fit: { eles: cy.elements(), padding: 40 },
        duration: 400,
        easing: 'ease-out'
      });
    }
  });
  
  // ===== Manual edge creation =====
  let startNode = null;
  let previewEdge = null;
  let dummyNode = null;

  function cleanupPreview() {
    if (previewEdge) previewEdge.remove();
    if (dummyNode) dummyNode.remove();
    previewEdge = null;
    dummyNode = null;
  }

  // Simplified event for manual link creation
  cy.on('tap', 'node', function (evt) {
    if (!linkMode) return;

    const node = evt.target;

    // Primer clic: Iniciar el enlace
    if (!startNode) {
      startNode = node;
      cy.autoungrabify(true); // Bloquea el movimiento de nodos

      dummyNode = cy.add({
        group: 'nodes',
        data: { id: 'dummy' },
        position: node.position(),
        style: { 'opacity': 0 }
      });

      previewEdge = cy.add({
        group: 'edges',
        data: { source: startNode.id(), target: 'dummy' },
        classes: 'preview'
      });

      // Mover el extremo del preview con el cursor
      cy.off('mousemove.preview');
      cy.on('mousemove.preview', (e) => {
        if (dummyNode) dummyNode.position(e.position);
      });

      return;
    }

    // Segundo clic: Crear el enlace y finalizar
    const targetNode = evt.target;
    if (startNode.id() !== targetNode.id()) {
      vscode.postMessage({
        type: 'create-link',
        src: startNode.id(),
        dst: targetNode.id(),
        rel: 'manual' // Relationship type fixed to 'manual'
      });
      showNotification('Manual connection created!');
    }

    // Clean up and exit preview mode
    cy.off('mousemove.preview');
    cleanupPreview();
    startNode = null;
    cy.autoungrabify(false);
  });

  // --- Event: DELETE a link by right-clicking on a LINE (EDGE) ---
  cy.on('cxttap', 'edge', function(evt) {
    if (!linkMode) return;

    const edge = evt.target;
    const edgeData = edge.data();

    // Solo permite borrar relaciones manuales que vienen de la BBDD (tienen ID)
    if (edgeData.id && typeof edgeData.rel === 'string' &&
        ['manual'].includes(edgeData.rel.toLowerCase())) {
        showConfirm('Are you sure you want to delete this manual connection?', () => {
            vscode.postMessage({
                type: 'delete-link',
                id: edgeData.id
            });
            showNotification('Connection deleted.');
        });
    }
  });

  // ESC → cancelar preview actual
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && linkMode) {
      cy.off('mousemove.preview');
      cleanupPreview();
      startNode = null;
      cy.autoungrabify(false);
    }
  });
  // ===== End manual edge creation block =====


  // Set up tooltip handling
  cy.on('mouseover', 'node', function(e) {
    if (linkMode) return;

    const node = e.target;
    const type = node.data('type') || 'Note';
    const text = node.data('text') || node.data('label') || 'No content';
    const path = node.data('file_path') || 'No file associated';
    const created = new Date(node.data('timestamp') || Date.now()).toLocaleDateString();
    const priority = node.data('priority');
    const status = node.data('status');

    let titleText = type.charAt(0).toUpperCase() + type.slice(1);
    if (type.toLowerCase() === 'task' && priority) {
      titleText += \` | Priority: \${priority}\`;
    }
    if (type.toLowerCase() === 'task' && status) {
      titleText += \` | Status: \${String(status).replace(/-/g, ' ')}\`;
    }

    const div = document.createElement('div');
    div.className = 'cy-tooltip';
    div.innerHTML = \`
      <div class="tooltip-title">\${titleText}</div>
      <div class="tooltip-content">\${text}</div>
      <div class="tooltip-meta">
        <strong>File:</strong> \${path}<br>
        <strong>Created:</strong> \${created}
      </div>
    \`;
    document.body.appendChild(div);

    // Use node position instead of mouse coordinates
    const nodePos = node.renderedPosition();
    const containerRect = cy.container().getBoundingClientRect();
    
    // Convertir coordenadas del nodo a coordenadas de pantalla
    const screenX = nodePos.x + containerRect.left;
    const screenY = nodePos.y + containerRect.top;
    
    const rect = div.getBoundingClientRect();
    const tooltipWidth = rect.width;
    const tooltipHeight = rect.height;
    
    // Position directly above the node as first option
    let left = screenX - (tooltipWidth / 2); // Centered horizontal
    let top = screenY - tooltipHeight - 10; // 10px arriba del nodo
    
    // Si el tooltip sale por arriba (colisiona con toolbar), colocarlo abajo
    if (top < 70) { // 70px para dar margen a la toolbar
      top = screenY + 10; // Debajo del nodo
    }
    
    // Asegurarse que no se salga de la pantalla horizontalmente
    if (left < 10) {
      left = 10; // Margen izquierdo
    } else if (left + tooltipWidth > window.innerWidth - 10) {
      left = window.innerWidth - tooltipWidth - 10; // Margen derecho
    }
    
    // Apply position with !important to ensure it is applied
    div.style.cssText = \`
      left: \${left}px !important;
      top: \${top}px !important;
      z-index: 9999 !important;
    \`;

  });

  cy.on('mouseout', 'node', function() {
    const tooltip = document.querySelector('.cy-tooltip');
    if (tooltip) {
      document.body.removeChild(tooltip);
    }
    cy.elements().removeClass('dimmed highlighted highlighted-edge');
  });

  document.getElementById('cy').addEventListener('mouseleave', function() {
    const tooltip = document.querySelector('.cy-tooltip');
    if (tooltip) {
      document.body.removeChild(tooltip);
    }
    cy.elements().removeClass('dimmed highlighted highlighted-edge');
  });

  cy.on('mouseover', 'node', function(e) {
    if (linkMode) return;
    const node = e.target;
    const neighborhood = node.neighborhood().add(node);
    cy.elements().not(neighborhood).addClass('dimmed');
    neighborhood.nodes().addClass('highlighted');
    neighborhood.edges().addClass('highlighted-edge');
  });

  
  // Zoom slider control
  const zoomSlider = document.getElementById('zoom-slider');
  const zoomLevel = document.getElementById('zoom-level');
  const zoomInBtn = document.getElementById('zoom-in');
  const zoomOutBtn = document.getElementById('zoom-out');

  function updateZoomDisplay(zoom) {
    const percentage = Math.round(zoom * 100);
    zoomLevel.textContent = percentage + '%';
    zoomSlider.value = zoom;
  }

  zoomSlider.addEventListener('input', (e) => {
    const zoom = parseFloat(e.target.value);
    cy.zoom(zoom);
    cy.center();
    updateZoomDisplay(zoom);
  });

  zoomInBtn.addEventListener('click', () => {
    const currentZoom = cy.zoom();
    const newZoom = Math.min(currentZoom + 0.2, 3);
    cy.zoom(newZoom);
    cy.center();
    updateZoomDisplay(newZoom);
  });

  zoomOutBtn.addEventListener('click', () => {
    const currentZoom = cy.zoom();
    const newZoom = Math.max(currentZoom - 0.2, 0.25);
    cy.zoom(newZoom);
    cy.center();
    updateZoomDisplay(newZoom);
  });

  cy.on('zoom', () => {
    updateZoomDisplay(cy.zoom());
  });



  // Set initial node weights and apply advanced styling
  cy.ready(() => {
    cy.nodes().forEach(node => {
      const connections = node.connectedEdges().length;
      const weight = Math.min(Math.max(connections, 1), 10);
      node.data('weight', weight);
      
      // Apply special styling for hub nodes (high connectivity)
      if (connections >= 5) {
        node.addClass('hub-node');
        node.style({
          'border-width': 4,
          'box-shadow': '0 0 25px rgba(0, 120, 212, 0.5)',
          'z-index': 10
        });
      }
      
      // Apply glow effect for highly connected nodes
      if (connections >= 8) {
        node.style({
          'box-shadow': '0 0 35px rgba(255, 215, 0, 0.6)',
          'border-color': '#ffd700'
        });
      }
    });
    
    // Add CSS rule for hub nodes
    cy.style()
      .selector('.hub-node')
      .style({
        'transition-property': 'border-color, box-shadow, background-color',
        'transition-duration': '0.3s'
      })
      .update();
  });
}

// Layout handling
function applyLayout(layoutData) {
  if (!cy) return;
  
  console.log('Received layout data:', layoutData);
  
  if (layoutData && Object.keys(layoutData).length > 0) {
    
    Object.keys(layoutData).forEach(nodeId => {
      const node = cy.getElementById(nodeId);
      if (node.length > 0) {
        node.position(layoutData[nodeId]);
      }
    });
    // Apply moderate zoom after loading layout
    setTimeout(() => {
      if (cy) {
        cy.animate({
          fit: {
            eles: cy.nodes(),
            padding: 100
          },
          duration: 600,
          easing: 'ease-out'
        });
      }
    }, 100);
    layoutLoaded = true;
  } else {
    console.log('No layout data available, applying force-directed layout');

    cy.nodes().forEach(node => {
      node.position({
        x: (Math.random() - 0.5) * 600,
        y: (Math.random() - 0.5) * 600
      });
    });

    cy.layout({
      name: 'cola',
      animate: true,
      animationDuration: 1200,
      maxSimulationTime: 3000,
      ungrabifyWhileSimulating: false,
      nodeSpacing: 20,
      edgeLength: function(edge) {
        const src = edge.source();
        const tgt = edge.target();
        const srcDeg = src.connectedEdges().length;
        const tgtDeg = tgt.connectedEdges().length;
        const isLeaf = srcDeg <= 2 || tgtDeg <= 2;
        return isLeaf ? 40 : 160;
      },
      fit: false,
      randomize: false,
      avoidOverlap: true,
      convergenceThreshold: 0.01,
      ready: function() {
        setTimeout(() => {
          if (cy) {
            cy.animate({
              fit: { eles: cy.nodes(), padding: 100 },
              duration: 600,
              easing: 'ease-out'
            });
          }
        }, 300);
      }
    }).run();
  }
}

// Search functions
function searchNodes(term) {
  if (searchHighlight) {
    searchHighlight.removeClass('search-match');
  }
  
  if (!term) return;
  
  const matches = cy.nodes().filter(node => {
    const label = node.data('label') || '';
    const text = node.data('text') || '';
    return label.toLowerCase().includes(term.toLowerCase()) || text.toLowerCase().includes(term.toLowerCase());
  });
  
  if (matches.length > 0) {
    matches.addClass('search-match');
    searchHighlight = matches;
    
    cy.animate({
      fit: {
        eles: matches,
        padding: 50
      },
      duration: 500
    });
  }
}

// Filtering functions
function filterByType(type) {
  if (!cy) return;
  
  cy.elements().removeClass('filtered');
  cy.elements().style('opacity', 1);
  
  if (!type) {
    filteredType = null;
    document.getElementById('btn-filter').classList.remove('active');
    return;
  }
  
  const matches = cy.nodes().filter('node[type = "' + type + '"]');
  const nonMatches = cy.nodes().not(matches);
  const connectedEdges = matches.connectedEdges();
  const otherEdges = cy.edges().not(connectedEdges);
  
  nonMatches.style('opacity', 0.3);
  otherEdges.style('opacity', 0.1);
  
  matches.addClass('filtered');
  connectedEdges.addClass('filtered');
  
  filteredType = type;
  document.getElementById('btn-filter').classList.add('active');
  
  if (matches.length > 0) {
    // Automatic zoom adjustment based on number of matches
    if (matches.length === 1) {
      // For a single node: reasonable fixed zoom
      cy.animate({
        center: { eles: matches },
        zoom: 0.4, // Controlled zoom to avoid excessive zooming
        duration: 500
      });
    } else if (matches.length <= 3) {
      // For a few nodes: moderate zoom
      cy.animate({
        center: { eles: matches },
        zoom: 0.4,
        duration: 500
      });
    } else {
      // For many nodes: normal fit
      cy.animate({
        fit: {
          eles: matches,
          padding: 50
        },
        duration: 500
      });
    }
  }
}

// Interface initialization
document.addEventListener('DOMContentLoaded', () => {
  // Show/hide insights panel
  const toggleInsights = document.getElementById('toggle-insights');
  if (toggleInsights) {
    toggleInsights.addEventListener('click', () => {
      document.getElementById('insights').classList.toggle('visible');
    });
  } else {
    console.error("Toggle insights button not found");
  }
  
  // Refresh graph button
  const refreshGraph = document.getElementById('refresh-graph');
  if (refreshGraph) {
    refreshGraph.addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh-graph' });
      showNotification('Refreshing graph...');
    });
  } else {
    console.error("Refresh graph button not found");
  }
  
  // Search
  const searchButton = document.getElementById('search-button');
  if (searchButton) {
    searchButton.addEventListener('click', () => {
      const term = document.getElementById('search-input').value.trim();
      searchNodes(term);
      document.getElementById('search-input').value = '';
    });
  } else {
    console.error("Search button not found");
  }
  
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') {
        const term = searchInput.value.trim();
        searchNodes(term);
        searchInput.value = '';
      }
    });
  } else {
    console.error("Search input not found");
  }
  
  // Set initial state of semantic button
  if (${this.showSemantic}) {
    document.getElementById('btn-sem').classList.add('active');
  } else {
    document.getElementById('btn-sem').classList.remove('active');
  }
});

// Toolbar button controllers
const btnSem = document.getElementById('btn-sem');
if (btnSem) {
  btnSem.addEventListener('click', () => {
    btnSem.classList.toggle('active');
    vscode.postMessage({type: 'toggle-semantic'});
  });
} else {
  console.error("Semantic AI button not found");
}

const btnRecenter = document.getElementById('btn-recenter');
if (btnRecenter) {
  btnRecenter.addEventListener('click', () => {
    if (cy) cy.fit(undefined, 50);
  });
} else {
  console.error("Recenter button not found");
}

const btnLink = document.getElementById('btn-link');
if (btnLink) {
  btnLink.addEventListener('click', () => {
    if (!cy) {
      console.error("Graph not initialized yet");
      showNotification('Graph not initialized yet', true);
      return;
    }
    
    linkMode = !linkMode;
    btnLink.classList.toggle('active');
    
    if (linkMode) {
      cy.nodes().addClass('can-link');
      
      const notification = document.createElement('div');
      notification.className = 'edge-created-notification';
      notification.textContent = 'Link mode active: Drag from one node to another to create connection';
      notification.style.backgroundColor = 'rgba(0,120,212,0.8)';
      document.body.appendChild(notification);
      
      setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => {
          if (document.body.contains(notification)) {
            document.body.removeChild(notification);
          }
        }, 500);
      }, 3000);
    } else {
      cy.nodes().removeClass('can-link');
      if (previewEdge) previewEdge.remove();
      startNode = null;
      cy.autoungrabify(false);
    }
  });
} else {
  console.error("Link button not found");
}

const btnFilter = document.getElementById('btn-filter');
if (btnFilter) {
  btnFilter.addEventListener('click', () => {
    if (filteredType) {
      filterByType(null);
    } else {
      const types = ['decision', 'hypothesis', 'insight', 'note', 'task', 'risk', 'discard'];
      const menu = document.createElement('div');
      menu.style = 'position:absolute;z-index:100;background:#333;padding:5px;border-radius:4px';
      menu.style.left = document.getElementById('btn-filter').offsetLeft + 'px';
      menu.style.top = (document.getElementById('btn-filter').offsetTop + 30) + 'px';
      
      types.forEach(type => {
        const item = document.createElement('div');
        item.innerText = type.charAt(0).toUpperCase() + type.slice(1);
        item.style = 'padding:5px 10px;cursor:pointer;color:#fff';
        item.onmouseover = () => item.style.backgroundColor = '#555';
        item.onmouseout = () => item.style.backgroundColor = 'transparent';
        item.onclick = () => {
          filterByType(type);
          document.body.removeChild(menu);
        };
        menu.appendChild(item);
      });
      
      document.body.appendChild(menu);
      setTimeout(() => {
        const clickHandler = () => {
          if (document.body.contains(menu)) {
            document.body.removeChild(menu);
          }
          document.removeEventListener('click', clickHandler);
        };
        document.addEventListener('click', clickHandler);
      }, 100);
    }
  });
} else {
  console.error("Filter button not found");
}

const btnSave = document.getElementById('btn-save');
if (btnSave) {
  btnSave.addEventListener('click', () => {
    const layoutObj = {};
    cy.nodes().forEach(n => {
      layoutObj[n.id()] = {x: n.position('x'), y: n.position('y')};
    });
    vscode.postMessage({
      type: 'save-layout', 
      payload: {layout_dict: layoutObj}
    });
    
    const savedIndicator = document.createElement('div');
    savedIndicator.style.position = 'fixed';
    savedIndicator.style.bottom = '20px';
    savedIndicator.style.left = '50%';
    savedIndicator.style.transform = 'translateX(-50%)';
    savedIndicator.style.backgroundColor = 'rgba(40, 167, 69, 0.8)';
    savedIndicator.style.color = 'white';
    savedIndicator.style.padding = '8px 16px';
    savedIndicator.style.borderRadius = '4px';
    savedIndicator.style.zIndex = '1000';
    savedIndicator.style.transition = 'opacity 0.5s';
    savedIndicator.textContent = 'Layout saved successfully!';
    
    document.body.appendChild(savedIndicator);
    
    setTimeout(() => {
      savedIndicator.style.opacity = '0';
      setTimeout(() => {
        if (document.body.contains(savedIndicator)) {
          document.body.removeChild(savedIndicator);
        }
      }, 500);
    }, 2000);
  });
} else {
  console.error("Save button not found");
}

const btnZoomFit = document.getElementById('btn-zoom-fit');
if (btnZoomFit) {
  btnZoomFit.addEventListener('click', () => {
    if (cy) {
      const nodeCount = cy.nodes().length;
      
      // Calculate optimal zoom based on node count
      let optimalZoom = 1.0;
      if (nodeCount <= 5) {
        optimalZoom = 1.5;
      } else if (nodeCount <= 15) {
        optimalZoom = 1.2;
      } else if (nodeCount <= 30) {
        optimalZoom = 0.9;
      } else if (nodeCount <= 50) {
        optimalZoom = 0.7;
      } else {
        optimalZoom = 0.5;
      }
      
      cy.animate({
        fit: {
          eles: cy.nodes(),
          padding: 50
        },
        zoom: optimalZoom
      }, {
        duration: 800,
        easing: 'ease-in-out'
      });
      
      showNotification(\`Auto-adjusted zoom for \${nodeCount} nodes\`);
    }
  });
} else {
  console.error("Auto zoom button not found");
}

let readableMode = false;
const btnReadable = document.getElementById('btn-readable');
if (btnReadable) {
  btnReadable.addEventListener('click', () => {
    readableMode = !readableMode;
    btnReadable.classList.toggle('active');
    
    const body = document.body;
    if (readableMode) {
      body.classList.add('readable-mode');
      if (cy) {
        // Apply readable mode styles
        cy.style()
          .selector('node')
          .style({
            'font-size': '14px',
            'font-weight': 'bold',
            'text-outline-width': 4,
            'text-outline-color': '#000',
            'text-background-color': 'rgba(0,0,0,0.8)',
            'text-background-padding': '6px',
            'width': 'mapData(weight, 1, 10, 25, 60)',
            'height': 'mapData(weight, 1, 10, 25, 60)'
          })
          .update();
        
        // Auto-adjust zoom for better readability
        const nodeCount = cy.nodes().length;
        const readableZoom = Math.min(1.2, 15 / Math.sqrt(nodeCount));
        cy.animate({
          zoom: readableZoom,
          center: { eles: cy.nodes() }
        }, { duration: 600 });
      }
      showNotification('High readability mode enabled');
    } else {
      body.classList.remove('readable-mode');
      if (cy) {
        // Restore normal mode styles
        cy.style()
          .selector('node')
          .style({
            'font-size': '12px',
            'font-weight': 'bold',
            'text-outline-width': 3,
            'text-outline-color': '#000',
            'text-background-color': 'rgba(0,0,0,0.7)',
            'text-background-padding': '4px',
            'width': 'mapData(weight, 1, 10, 20, 50)',
            'height': 'mapData(weight, 1, 10, 20, 50)'
          })
          .update();
      }
      showNotification('Normal mode restored');
    }
  });
} else {
  console.error("Readable mode button not found");
}

// Help modal functionality
const helpButton = document.getElementById('btn-help');
if (helpButton) {
  helpButton.addEventListener('click', function() {
    showHelpModal();
  });
} else {
  console.error("Help button not found");
}

function showHelpModal() {
  const modal = document.getElementById('help-modal');
  if (modal) {
    modal.classList.add('visible');
    // Prevent body scroll when modal is open
    document.body.style.overflow = 'hidden';
  }
}

function closeHelpModal() {
  const modal = document.getElementById('help-modal');
  if (modal) {
    modal.classList.remove('visible');
    // Restore body scroll
    document.body.style.overflow = 'auto';
  }
}

// Close modal when clicking outside content
document.addEventListener('click', function(e) {
  const modal = document.getElementById('help-modal');
  if (modal && e.target === modal) {
    closeHelpModal();
  }
});

// Close modal with Escape key
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeHelpModal();
  }
});

</script>

<!-- Modal de ayuda -->
<div id="help-modal">
  <div class="help-content">
    <button class="help-close" onclick="closeHelpModal()">×</button>
    <h2>Thought Graph User Guide</h2>
    
    <div class="help-section">
      <h3>🔗 Creating Manual Links</h3>
      <p>To manually connect thoughts between nodes:</p>
      <ul>
        <li>Click the <strong>"Link"</strong> button in the toolbar to activate link mode</li>
        <li>Click on the <strong>first node</strong> you want to connect (it will start the link)</li>
        <li>Click on the <strong>second node</strong> to complete the connection</li>
        <li>A manual link will be created between both nodes</li>
        <li>Click the "Link" button again to exit link mode</li>
      </ul>
      <div class="help-tip">
        <p>When link mode is active, you'll see a blue notification and nodes will be highlighted. You can also see a preview line while creating the connection.</p>
      </div>
    </div>

    <div class="help-section">
      <h3>🗑️ Deleting Links</h3>
      <p>To remove connections between nodes:</p>
      <ul>
        <li>First, activate <strong>link mode</strong> by clicking the "Link" button</li>
        <li><strong>Right-click</strong> directly on the link you want to delete</li>
        <li>A confirmation dialog will appear</li>
        <li>Click "Yes" to confirm deletion</li>
      </ul>
      <div class="help-tip">
        <p>Only manual links can be deleted. Automatic AI-generated connections are permanent and protected.</p>
      </div>
    </div>

    <div class="help-section">
      <h3>🎯 Graph Navigation</h3>
      <p>Basic controls to explore your thought network:</p>
      <ul>
        <li><strong>Zoom:</strong> Mouse wheel or pinch gesture</li>
        <li><strong>Pan view:</strong> Click and drag on empty graph area</li>
        <li><strong>Move nodes:</strong> Drag individual nodes (when not in link mode)</li>
        <li><strong>Open thoughts:</strong> Click on any node to open that thought</li>
        <li><strong>Auto zoom:</strong> Use "Auto Zoom" button for optimal view</li>
      </ul>
    </div>

    <div class="help-section">
      <h3>🔍 Search and Filters</h3>
      <p>Tools to find specific information:</p>
      <ul>
        <li><strong>Search:</strong> Type in the search bar to find nodes by text content</li>
        <li><strong>Search results:</strong> Matching nodes will be highlighted and centered</li>
        <li><strong>Filter:</strong> Use the Filter button to show/hide specific node types</li>
        <li><strong>Center:</strong> Use Center button to focus on specific nodes</li>
      </ul>
    </div>

    <div class="help-section">
      <h3>🛠️ Toolbar Functions</h3>
      <p>Available actions in the toolbar:</p>
      <ul>
        <li><strong>Insights:</strong> Toggle analysis panel with graph statistics</li>
        <li><strong>Refresh:</strong> Reload the graph with latest data</li>
        <li><strong>Semantic:</strong> Apply semantic-based layout algorithm</li>
        <li><strong>Center:</strong> Center view on selected or important nodes</li>
        <li><strong>Link:</strong> Toggle manual link creation/deletion mode</li>
        <li><strong>Filter:</strong> Show dropdown to filter node types</li>
        <li><strong>Save:</strong> Save current node positions as layout</li>
        <li><strong>Auto Zoom:</strong> Automatically adjust zoom for readability</li>
        <li><strong>Read:</strong> Toggle high-contrast readability mode</li>
      </ul>
    </div>
  </div>
</div>

</body></html>`;
  }
}


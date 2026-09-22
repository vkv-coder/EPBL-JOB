// ═══════════════════════════════════════════════════════════════
// JOB TRACKER — APPS SCRIPT v6
// Changes in v6:
//  - Auto-assign DISABLED (createJob, approveInspection, stampStop, adminStop)
//  - runAutoAssignAll → no-op
//  - Inspectors: Arvind (9898363770) + Hardik (7041327207)
//  - Anupam (W010) Inactive — admin only
//  - Worker START/STOP blocked — admin controls only
//  - Manual Assign allows Rework + In Progress seqs
//  - Duplicate assignment prevention in apiAssignWorker
//  - cleanDuplicateAssignments() one-time cleanup function
//  - INSPECTION rows excluded from all counts
// ═══════════════════════════════════════════════════════════════

const ADMIN_EMAILS = [
  'shahkartik77@gmail.com',    // Director 1 — Kartik
  'vslol1410@gmail.com',       // Director 2
  'ebplqc@gmail.com',          // Arvind + Hardik + Anupam — Inspector + Admin
  'unigoods2026@gmail.com',    // Developer — remove when handing over
];

// Both Arvind and Hardik are inspectors — both get notified
const INSPECTORS = [
  {name:'Arvind', mobile:'9898363770'},
  {name:'Hardik',  mobile:'7041327207'}
];

const SH_JOBS        = 'Jobs';
const SH_SCHEDULE    = 'Schedule';
const SH_DEPTS       = 'Departments';
const SH_WORKERS     = 'Workers';
const SH_ASSIGNMENTS = 'Assignments';
const SH_INSPECTIONS = 'Inspections';
const SH_SUMMARY     = 'Summary';
const SH_MASTER      = 'Master';
const NOTIFY_EMAIL   = 'factory@energypackboilers.com';

const DEPT_GU = {"Fitting":"ફીટિંગ","Cutting":"કટિંગ","Welding":"વેલ્ડિંગ","Machining":"મશીનિંગ","Drilling":"ડ્રિલિંગ","Bending":"બેન્ડિંગ","Assembly":"એસેમ્બ્લી","Painting":"પેઇન્ટિંગ","Grinding":"ગ્રાઇન્ડિંગ","Wiring":"વાયરિંગ","Insulation":"ઇન્સ્યુલેશન","Refractory":"રિફ્રેક્ટરી","Testing":"ટેસ્ટિંગ","Inspection":"ઇન્સ્પેક્શન"};

const WORK_START = 8;
const WORK_HRS   = 8;

// ── WORKING HOURS ──
function addWorkHrs(start, hours) {
  let d = new Date(start), rem = hours;
  while (rem > 0) {
    if (d.getDay()===0) { d.setDate(d.getDate()+1); d.setHours(WORK_START,0,0,0); continue; }
    const eod = new Date(d); eod.setHours(WORK_START+WORK_HRS,0,0,0);
    const avail = (eod-d)/3600000;
    if (rem<=avail) { d=new Date(d.getTime()+rem*3600000); rem=0; }
    else { rem-=avail; d.setDate(d.getDate()+1); if(d.getDay()===0) d.setDate(d.getDate()+1); d.setHours(WORK_START,0,0,0); }
  }
  return d;
}

function nextWorkDay(date) {
  const d=new Date(date);
  if(d.getDay()===0) { d.setDate(d.getDate()+1); d.setHours(WORK_START,0,0,0); }
  return d;
}

function calcWorkingHrsDelay(planEnd, actualEnd) {
  if (!planEnd||!actualEnd) return 0;
  const pE=new Date(planEnd), aE=new Date(actualEnd);
  if (aE<=pE) return Math.round((aE-pE)/3600000*10)/10;
  let hrs=0, cur=new Date(pE);
  while (cur<aE) {
    if (cur.getDay()!==0) {
      const dayEnd=new Date(cur); dayEnd.setHours(WORK_START+WORK_HRS,0,0,0);
      const segEnd=dayEnd<aE?dayEnd:aE;
      if (segEnd>cur) hrs+=(segEnd-cur)/3600000;
    }
    cur=new Date(cur); cur.setDate(cur.getDate()+1); cur.setHours(WORK_START,0,0,0);
  }
  return Math.round(hrs*10)/10;
}

// ── PIN HASH ──
function hashPin(mobile, pin) {
  let h=0; const s=mobile+'|'+pin+'|jt2024';
  for (let i=0;i<s.length;i++) { h=((h<<5)-h)+s.charCodeAt(i); h|=0; }
  return Math.abs(h).toString(36);
}

// ── STATUS COLORS ──
const STATUS_COLORS = {
  'Not Started':           {bg:'#ffffff', fg:'#374151'},
  'Not Yet Due':           {bg:'#ffffff', fg:'#374151'},
  'Due Today — Unassigned':{bg:'#fef08a', fg:'#000000'},
  'Due Today — Assigned':  {bg:'#93c5fd', fg:'#000000'},
  'Overdue — Unassigned':  {bg:'#fca5a5', fg:'#000000'},
  'Overdue — Assigned':    {bg:'#fdba74', fg:'#000000'},
  'Overdue — Not Started': {bg:'#fca5a5', fg:'#000000'},
  'In Progress — On Time': {bg:'#fdba74', fg:'#000000'},
  'Running — Delayed':     {bg:'#c4b5fd', fg:'#000000'},
  'Completed — Pending Inspection': {bg:'#fde68a', fg:'#000000'},
  'Inspection — Pending':  {bg:'#fde68a', fg:'#000000'},
  'Inspection — Rejected': {bg:'#fca5a5', fg:'#000000'},
  'Completed — On Time':   {bg:'#86efac', fg:'#000000'},
  'Completed — Delayed':   {bg:'#d8b4fe', fg:'#000000'},
};

// ── READ MASTER FROM SHEET ──
function getMasterFromSheet(productType, ss) {
  const sh = ss.getSheetByName(SH_MASTER);
  if (!sh) return [];
  const data = sh.getDataRange().getValues();
  const procs = [];
  for (let i=1;i<data.length;i++) {
    if (data[i][0]!==productType) continue;
    procs.push({
      seq:   parseInt(data[i][1]),
      name:  String(data[i][2]).trim(),
      dur:   parseFloat(data[i][3])||2,
      worker:String(data[i][4]).trim(),
      mobile:String(data[i][5]).trim(),
      isInsp:data[i][6]===true||String(data[i][6]).toLowerCase()==='true'
    });
  }
  procs.sort((a,b)=>a.seq-b.seq);
  return procs;
}

// ── SETUP SHEETS ──
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let sh = ss.getSheetByName(SH_JOBS)||ss.insertSheet(SH_JOBS);
  sh.clearContents();
  sh.getRange(1,1,1,6).setValues([['JobNo','ProductType','CustomerName','StartDate','CreatedAt','Notes']]);
  sh.setFrozenRows(1);

  sh = ss.getSheetByName(SH_SCHEDULE)||ss.insertSheet(SH_SCHEDULE);
  sh.clearContents();
  sh.getRange(1,1,1,16).setValues([['JobNo','ProductType','Customer','Seq','ProcessName','DefaultWorker','DefaultMobile',
    'DurHrs','PlanStart','PlanEnd','ActStart','ActEnd','DelayHrs','Status','StatusText','Notes']]);
  sh.setFrozenRows(1);

  sh = ss.getSheetByName(SH_DEPTS)||ss.insertSheet(SH_DEPTS);
  sh.clearContents();
  sh.getRange(1,1,1,3).setValues([['DeptName','GujaratiName','Active']]);
  const depts = ['Assembly','Bending','Cutting','Drilling','Fitting','Grinding',
                 'Inspection','Insulation','Machining','Painting','Refractory','Testing','Welding','Wiring'];
  sh.getRange(2,1,depts.length,3).setValues(depts.map(d=>[d,DEPT_GU[d]||d,'YES']));
  sh.setFrozenRows(1);

  sh = ss.getSheetByName(SH_WORKERS)||ss.insertSheet(SH_WORKERS);
  sh.clearContents();
  sh.getRange(1,1,1,9).setValues([['WorkerID','Name','Mobile','Dept1','Dept2','PinHash','Status','CreatedAt','CreatedBy']]);
  sh.setFrozenRows(1);

  sh = ss.getSheetByName(SH_ASSIGNMENTS)||ss.insertSheet(SH_ASSIGNMENTS);
  sh.clearContents();
  sh.getRange(1,1,1,10).setValues([['AssignID','JobNo','Seq','Dept','WorkerID','WorkerName','AssignedAt','Status','AssignedBy','ManualAssign']]);
  sh.setFrozenRows(1);

  sh = ss.getSheetByName(SH_INSPECTIONS)||ss.insertSheet(SH_INSPECTIONS);
  sh.clearContents();
  sh.getRange(1,1,1,10).setValues([['InspID','JobNo','Seq','ProcessName','WorkerName','CompletedAt','InspectedAt','Result','Remarks','InspectedBy']]);
  sh.setFrozenRows(1);

  sh = ss.getSheetByName(SH_MASTER)||ss.insertSheet(SH_MASTER);
  sh.clearContents();
  sh.getRange(1,1,1,7).setValues([['ProductType','Seq','ProcessName','DurHrs','DefaultWorker','DefaultMobile','IsInspection']]);
  sh.setFrozenRows(1);
  sh.getRange(1,1,1,7).setBackground('#0d1b3e').setFontColor('#ffffff').setFontWeight('bold');
  sh.setColumnWidth(3, 300);

  sh = ss.getSheetByName(SH_SUMMARY)||ss.insertSheet(SH_SUMMARY);
  sh.clearContents();
  sh.getRange(1,1,1,12).setValues([['JobNo','ProductType','Customer',
    'PlannedStart','PlannedEnd','ActualStart','ActualEnd',
    'StandardHrs','ActualHrs','CalendarDays','DelayHrs','Status']]);
  sh.setFrozenRows(1);
  sh.getRange(1,1,1,12).setBackground('#0d1b3e').setFontColor('#ffffff').setFontWeight('bold');

  SpreadsheetApp.getUi().alert('Setup v5 complete!');
}

// ── DEACTIVATE ANUPAM ──
// Run once to mark Anupam (W010) Inactive
function deactivateAnupam() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_WORKERS);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++) {
    if (data[i][0]==='W010' || String(data[i][1]).toLowerCase().includes('anupam')) {
      sh.getRange(i+1,7).setValue('Inactive');
      Logger.log('Anupam marked Inactive at row '+(i+1));
    }
  }
  SpreadsheetApp.getUi().alert('Anupam marked Inactive. She will no longer appear in worker dropdowns.');
}

// ══════════════════════════════════════════
// SERVER-SIDE BOARD CACHE
// Repeat reads of the same board within TTL skip re-reading full sheets.
// Any successful write action busts every board key (cheap and correct —
// simpler and safer than tracking exactly which board each write affects).
// ══════════════════════════════════════════
const BOARD_CACHE_TTL = 20; // seconds — "fresh" tier
const BOARD_CACHE_LKG_TTL = 21600; // 6h — "last known good" fallback tier, Apps Script's CacheService max
const BOARD_CACHE_KEYS = ['today_board','tomorrow_board','week_board','admin_jobs','all_workers','worker_board','summary_board','pending_inspections'];
const WRITE_ACTIONS = new Set(['createJob','assignWorker','reassignWorker','forceReassign','manualAssign',
  'stampStart','stampStop','adminStop','approveInspection','rejectInspection','deleteJob',
  'createWorker','toggleWorker','saveRemark','saveAdminNote']);

// Two cache tiers per board: a short "fresh" copy (served instantly, avoids
// re-reading full sheets) and a long-lived "last known good" copy that's only
// ever read as a fallback when a live read genuinely fails — so a transient
// Sheets error serves slightly-stale-but-real data instead of an error.
// The LKG tier is deliberately NOT cleared by invalidateBoardCaches(): it's a
// safety net for failures, not a freshness mechanism, and clearing it on every
// write would leave nothing to fall back to right when it's most needed.
function withBoardCache(key, ttlSec, computeFn) {
  const cache = CacheService.getScriptCache();
  try {
    const hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch(e) {}
  try {
    const result = computeFn();
    try {
      cache.put(key, JSON.stringify(result), ttlSec);
      cache.put(key+'_lkg', JSON.stringify(result), BOARD_CACHE_LKG_TTL);
    } catch(e) {} // silently skips if >100KB
    return result;
  } catch (computeErr) {
    try {
      const lkg = cache.get(key+'_lkg');
      if (lkg) { const parsed = JSON.parse(lkg); parsed._stale = true; return parsed; }
    } catch(e) {}
    throw computeErr; // nothing to fall back to — surface the real error, as before
  }
}

function invalidateBoardCaches() {
  try { CacheService.getScriptCache().removeAll(BOARD_CACHE_KEYS); } catch(e) {}
}

// ── WEB APP ──
function doGet(e)  { return handle(e); }
function doPost(e) { return handle(e); }

function handle(e) {
  const b = e.postData ? JSON.parse(e.postData.contents) : e.parameter;
  let result;
  try {
    const a = b.action;
    if      (a==='createJob')             result = apiCreateJob(b);
    else if (a==='getDeptJobs')           result = apiGetDeptJobs(b);
    else if (a==='getMyJobs')             result = apiGetMyJobs(b);
    else if (a==='getJobProcs')           result = apiGetJobProcs(b);
    else if (a==='getJobSchedule')        result = apiGetJobSchedule(b);
    else if (a==='stampStart')            result = apiStampStart(b);
    else if (a==='stampStop')             result = apiStampStop(b);
    else if (a==='saveRemark')            result = apiSaveRemark(b);
    else if (a==='getDepts')              result = apiGetDepts();
    else if (a==='adminJobs')             result = apiAdminJobs();
    else if (a==='getTodayBoard')         result = apiGetTodayBoard(b);
    else if (a==='getTomorrowBoard')      result = apiGetTomorrowBoard(b);
    else if (a==='getWeekBoard')          result = apiGetWeekBoard(b);
    else if (a==='assignWorker')          result = apiAssignWorker(b);
    else if (a==='reassignWorker')        result = apiReassignWorker(b);
    else if (a==='forceReassign')         result = apiForceReassign(b);
    else if (a==='manualAssign')          result = apiManualAssign(b);
    else if (a==='getWorkersByDept')      result = apiGetWorkersByDept(b);
    else if (a==='getWorkerBoard')        result = apiGetWorkerBoard(b);
    else if (a==='createWorker')          result = apiCreateWorker(b);
    else if (a==='workerLogin')           result = apiWorkerLogin(b);
    else if (a==='setPin')                result = apiSetPin(b);
    else if (a==='changePin')             result = apiChangePin(b);
    else if (a==='resetPin')              result = apiResetPin(b);
    else if (a==='requestAdminOtp')       result = apiRequestAdminOtp(b);
    else if (a==='verifyAdminOtp')        result = apiVerifyAdminOtp(b);
    else if (a==='getAllWorkers')          result = apiGetAllWorkers(b);
    else if (a==='toggleWorker')          result = apiToggleWorker(b);
    else if (a==='deleteJob')             result = apiDeleteJob(b);
    else if (a==='getUnassignedToday')    result = apiGetUnassignedToday(b);
    else if (a==='colorSchedule')         result = (colorScheduleSheet(),{success:true});
    else if (a==='getWorkerHistory')      result = apiGetWorkerHistory(b);
    else if (a==='getPendingInspections') result = apiGetPendingInspections(b);
    else if (a==='approveInspection')     result = apiApproveInspection(b);
    else if (a==='rejectInspection')      result = apiRejectInspection(b);
    else if (a==='getInspectionHistory')  result = apiGetInspectionHistory(b);
    else if (a==='getSummary')            result = apiGetSummary(b);
    else if (a==='adminStop')             result = apiAdminStop(b);
    else if (a==='saveAdminNote')         result = apiSaveAdminNote(b);
    else if (a==='searchJobs')            result = apiSearchJobs(b);
    else result = {error:'Unknown action: '+a};
    if (WRITE_ACTIONS.has(a) && result && result.success===true) invalidateBoardCaches();
  } catch(err) { result = {error: err.message}; }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════
// GET JOB SCHEDULE
// ══════════════════════════════════════════

function apiGetJobSchedule(b) {
  const {jobNo} = b;
  if (!jobNo) throw new Error('jobNo required');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
  const procs = [];
  for (let i=1;i<data.length;i++) {
    const r = data[i];
    if (String(r[0])!==String(jobNo)) continue;
    procs.push({
      seq:         r[3],
      processName: r[4],
      durHrs:      r[7],
      status:      r[13],
      isInspection: r[4]==='INSPECTION'
    });
  }
  procs.sort((a,b)=>a.seq-b.seq);
  return {success:true, jobNo, procs};
}

// ══════════════════════════════════════════
// MANUAL ASSIGN (out-of-order)
// ══════════════════════════════════════════

function apiManualAssign(b) {
  const {jobNo, seq, workerId, workerName, adminEmail} = b;
  if (!jobNo||!seq||!workerId||!workerName) throw new Error('Missing required fields');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSh  = ss.getSheetByName(SH_SCHEDULE);
  const assignSh = ss.getSheetByName(SH_ASSIGNMENTS);

  const schedData = schedSh.getDataRange().getValues();
  let procName = '', seqRow = -1;
  for (let i=1;i<schedData.length;i++) {
    if (String(schedData[i][0])===String(jobNo) && parseInt(schedData[i][3])===parseInt(seq)) {
      if (schedData[i][13]!=='Pending' && schedData[i][13]!=='Rework' && schedData[i][13]!=='In Progress')
        throw new Error('Seq '+seq+' cannot be assigned (status: '+schedData[i][13]+')');
      if (schedData[i][4]==='INSPECTION')
        throw new Error('Cannot manually assign an INSPECTION sequence');
      procName = schedData[i][4];
      seqRow = i+1;
      break;
    }
  }
  if (seqRow < 0) throw new Error('Seq '+seq+' not found for job '+jobNo);

  const assignData = assignSh.getDataRange().getValues();
  for (let i=1;i<assignData.length;i++) {
    if (String(assignData[i][1])===String(jobNo) &&
        parseInt(assignData[i][2])===parseInt(seq) &&
        assignData[i][7]==='Active')
      throw new Error('Seq '+seq+' already has an active assignment');
  }

  const assignId = 'A'+Date.now().toString(36).toUpperCase();
  assignSh.appendRow([assignId, jobNo, seq, 'Manual', workerId, workerName,
                      new Date(), 'Active', adminEmail||'Admin', 'Y']);

  colorScheduleRow(jobNo, seq, ss);

  const wData = ss.getSheetByName(SH_WORKERS).getDataRange().getValues();
  let mobile = '';
  for (let i=1;i<wData.length;i++) {
    if (wData[i][0]===workerId) { mobile = wData[i][2]; break; }
  }

  return {success:true, assignId, jobNo, seq, workerName,
          processName: procName,
          message: 'Seq '+seq+' manually assigned to '+workerName,
          whatsapp: {mobile, workerName, jobNo, seq, procName}};
}

// ══════════════════════════════════════════
// INSPECTION APIs
// ══════════════════════════════════════════

function apiGetPendingInspections(b) {
  return withBoardCache('pending_inspections', BOARD_CACHE_TTL, function(){ return _apiGetPendingInspections(b); });
}
function _apiGetPendingInspections(b) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const inspData = ss.getSheetByName(SH_INSPECTIONS).getDataRange().getValues();
  const pending = [];
  for (let i=1;i<inspData.length;i++) {
    const r=inspData[i];
    if (r[7]==='Pending') {
      pending.push({
        inspId:r[0], jobNo:r[1], seq:r[2],
        processName:r[3], workerName:r[4],
        completedAt:r[5]?fmtDT(new Date(r[5])):'',
        remarks:r[8]||''
      });
    }
  }
  return {success:true, pending, count:pending.length};
}

function apiApproveInspection(b) {
  const {inspId, jobNo, seq, adminEmail, remarks} = b;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const inspSh = ss.getSheetByName(SH_INSPECTIONS);
  const data = inspSh.getDataRange().getValues();
  const now = new Date();
  for (let i=1;i<data.length;i++) {
    if (data[i][0]===inspId) {
      const origInsp = data[i].slice(); // snapshot for rollback if a later write fails
      let schedRowIdx=-1, origSchedRow=null;
      let inspRowIdx=-1, origInspSchedRow=null;
      try {
        inspSh.getRange(i+1,7).setValue(now);
        inspSh.getRange(i+1,8).setValue('Approved');
        inspSh.getRange(i+1,9).setValue(remarks||'');
        inspSh.getRange(i+1,10).setValue(adminEmail||'');

        const schedSh = ss.getSheetByName(SH_SCHEDULE);
        const schedData = schedSh.getDataRange().getValues();
        let workActEnd = null;
        for (let j=1;j<schedData.length;j++) {
          if (String(schedData[j][0])===String(jobNo) && String(schedData[j][3])===String(seq)) {
            schedRowIdx=j; origSchedRow=schedData[j].slice();
            workActEnd = schedData[j][11] ? new Date(schedData[j][11]) : now;
            schedSh.getRange(j+1,14).setValue('Done');
            const stText = schedData[j][12]>0 ? 'Completed — Delayed' : 'Completed — On Time';
            schedSh.getRange(j+1,15).setValue(stText);
            const colors = STATUS_COLORS[stText];
            schedSh.getRange(j+1,1,1,15).setBackground(colors.bg).setFontColor('#000000');
          }
        }

        // Stamp the matching INSPECTION checkpoint row (next INSPECTION-named
        // seq after the work seq just approved) — otherwise its ActStart/ActEnd
        // stay blank forever since INSPECTION rows are never Start/Stop-able.
        let bestInspSeq = null;
        for (let j=1;j<schedData.length;j++) {
          if (String(schedData[j][0])!==String(jobNo)) continue;
          if (schedData[j][4]!=='INSPECTION') continue;
          if (schedData[j][13]==='Done') continue;
          const sSeq = parseInt(schedData[j][3]);
          if (sSeq>parseInt(seq) && (bestInspSeq===null || sSeq<bestInspSeq)) {
            bestInspSeq = sSeq; inspRowIdx = j;
          }
        }
        if (inspRowIdx>=0) {
          origInspSchedRow = schedData[inspRowIdx].slice();
          const planEnd = schedData[inspRowIdx][9] ? new Date(schedData[inspRowIdx][9]) : now;
          const inspDelay = calcWorkingHrsDelay(planEnd, now);
          schedSh.getRange(inspRowIdx+1,11).setValue(workActEnd);
          schedSh.getRange(inspRowIdx+1,12).setValue(now);
          schedSh.getRange(inspRowIdx+1,13).setValue(inspDelay);
          schedSh.getRange(inspRowIdx+1,14).setValue('Done');
          const inspStText = inspDelay>0 ? 'Completed — Delayed' : 'Completed — On Time';
          schedSh.getRange(inspRowIdx+1,15).setValue(inspStText);
          const inspColors = STATUS_COLORS[inspStText];
          schedSh.getRange(inspRowIdx+1,1,1,15).setBackground(inspColors.bg).setFontColor('#000000');
        }

        const assignSh = ss.getSheetByName(SH_ASSIGNMENTS);
        const assignData = assignSh.getDataRange().getValues();
        for (let j=1;j<assignData.length;j++) {
          if (String(assignData[j][1])===String(jobNo) && String(assignData[j][2])===String(seq) &&
             (assignData[j][7]==='Awaiting Inspection'||assignData[j][7]==='Active')) {
            assignSh.getRange(j+1,8).setValue('Completed');
          }
        }
      } catch (writeErr) {
        // Compensate: revert Inspection + Schedule to what they were before this
        // approval attempt, instead of leaving "Approved" with the job never
        // actually marked Done (or vice versa).
        inspSh.getRange(i+1,7).setValue(origInsp[6]||'');
        inspSh.getRange(i+1,8).setValue(origInsp[7]||'Pending');
        inspSh.getRange(i+1,9).setValue(origInsp[8]||'');
        inspSh.getRange(i+1,10).setValue(origInsp[9]||'');
        if (schedRowIdx>=0 && origSchedRow) {
          const schedSh = ss.getSheetByName(SH_SCHEDULE);
          const origStatusText = origSchedRow[14];
          schedSh.getRange(schedRowIdx+1,14).setValue(origSchedRow[13]);
          schedSh.getRange(schedRowIdx+1,15).setValue(origStatusText);
          const origColors = STATUS_COLORS[origStatusText]||{bg:'#fde68a'};
          schedSh.getRange(schedRowIdx+1,1,1,15).setBackground(origColors.bg).setFontColor('#000000');
        }
        if (inspRowIdx>=0 && origInspSchedRow) {
          const schedSh = ss.getSheetByName(SH_SCHEDULE);
          const origInspStatusText = origInspSchedRow[14];
          schedSh.getRange(inspRowIdx+1,11).setValue(origInspSchedRow[10]||'');
          schedSh.getRange(inspRowIdx+1,12).setValue(origInspSchedRow[11]||'');
          schedSh.getRange(inspRowIdx+1,13).setValue(origInspSchedRow[12]||'');
          schedSh.getRange(inspRowIdx+1,14).setValue(origInspSchedRow[13]);
          schedSh.getRange(inspRowIdx+1,15).setValue(origInspStatusText);
          const origInspColors = STATUS_COLORS[origInspStatusText]||{bg:'#fde68a'};
          schedSh.getRange(inspRowIdx+1,1,1,15).setBackground(origInspColors.bg).setFontColor('#000000');
        }
        throw new Error('Approval could not be fully saved — reverted, please try again. ('+writeErr.message+')');
      }

      // ── AUTO-ASSIGN DISABLED ──
      // No next process auto-assignment. Admin assigns manually.
      return {success:true, message:'Approved', nextAssigned:null};
    }
  }
  throw new Error('Inspection not found');
}

function apiRejectInspection(b) {
  const {inspId, jobNo, seq, workerName, workerMobile, remarks, adminEmail} = b;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const inspSh = ss.getSheetByName(SH_INSPECTIONS);
  const data = inspSh.getDataRange().getValues();
  const now = new Date();
  for (let i=1;i<data.length;i++) {
    if (data[i][0]===inspId) {
      const origInsp = data[i].slice(); // snapshot for rollback if a later write fails
      let schedRowIdx=-1, origSchedRow=null;
      try {
        inspSh.getRange(i+1,7).setValue(now);
        inspSh.getRange(i+1,8).setValue('Rejected');
        inspSh.getRange(i+1,9).setValue(remarks||'');
        inspSh.getRange(i+1,10).setValue(adminEmail||'');

        const schedSh = ss.getSheetByName(SH_SCHEDULE);
        const schedData = schedSh.getDataRange().getValues();
        for (let j=1;j<schedData.length;j++) {
          if (String(schedData[j][0])===String(jobNo) && String(schedData[j][3])===String(seq)) {
            schedRowIdx=j; origSchedRow=schedData[j].slice();
            schedSh.getRange(j+1,11).setValue('');
            schedSh.getRange(j+1,12).setValue('');
            schedSh.getRange(j+1,13).setValue('');
            schedSh.getRange(j+1,14).setValue('Rework');
            schedSh.getRange(j+1,15).setValue('Inspection — Rejected');
            schedSh.getRange(j+1,1,1,15).setBackground('#fca5a5').setFontColor('#000000');
          }
        }

        const assignSh = ss.getSheetByName(SH_ASSIGNMENTS);
        const assignData = assignSh.getDataRange().getValues();
        for (let j=1;j<assignData.length;j++) {
          if (String(assignData[j][1])===String(jobNo) &&
              String(assignData[j][2])===String(seq) &&
              assignData[j][7]==='Awaiting Inspection') {
            assignSh.getRange(j+1,8).setValue('Active');
          }
        }
      } catch (writeErr) {
        // Compensate: revert Inspection + Schedule to what they were before this
        // rejection attempt, instead of leaving "Rejected" with the schedule row
        // never actually reset to Rework (or vice versa).
        inspSh.getRange(i+1,7).setValue(origInsp[6]||'');
        inspSh.getRange(i+1,8).setValue(origInsp[7]||'Pending');
        inspSh.getRange(i+1,9).setValue(origInsp[8]||'');
        inspSh.getRange(i+1,10).setValue(origInsp[9]||'');
        if (schedRowIdx>=0 && origSchedRow) {
          const schedSh = ss.getSheetByName(SH_SCHEDULE);
          const origStatusText = origSchedRow[14];
          schedSh.getRange(schedRowIdx+1,11).setValue(origSchedRow[10]||'');
          schedSh.getRange(schedRowIdx+1,12).setValue(origSchedRow[11]||'');
          schedSh.getRange(schedRowIdx+1,13).setValue(origSchedRow[12]||'');
          schedSh.getRange(schedRowIdx+1,14).setValue(origSchedRow[13]);
          schedSh.getRange(schedRowIdx+1,15).setValue(origStatusText);
          const origColors = STATUS_COLORS[origStatusText]||{bg:'#fde68a'};
          schedSh.getRange(schedRowIdx+1,1,1,15).setBackground(origColors.bg).setFontColor('#000000');
        }
        throw new Error('Rejection could not be fully saved — reverted, please try again. ('+writeErr.message+')');
      }

      return {success:true, message:'Rejected',
              whatsapp:{mobile:workerMobile, workerName, jobNo, seq, remarks}};
    }
  }
  throw new Error('Inspection not found');
}

function apiGetInspectionHistory(b) {
  const {jobNo} = b;
  const data = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(SH_INSPECTIONS).getDataRange().getValues();
  const history = [];
  for (let i=1;i<data.length;i++) {
    const r=data[i];
    if (!jobNo || r[1]===jobNo) {
      history.push({
        inspId:r[0], jobNo:r[1], seq:r[2], processName:r[3],
        workerName:r[4], completedAt:r[5]?fmtDT(new Date(r[5])):'',
        inspectedAt:r[6]?fmtDT(new Date(r[6])):'',
        result:r[7]||'Pending', remarks:r[8]||'', inspectedBy:r[9]||''
      });
    }
  }
  return {success:true, history};
}

// ══════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════

// Admin login is two-step: knowing the email alone used to be enough to get
// in (apiVerifyAdmin, removed) - now a 6-digit code is emailed to that exact
// address and must be entered back, proving the caller actually controls
// that inbox rather than just having typed a known admin address.
function apiRequestAdminOtp(b) {
  const {email} = b;
  if (!email) throw new Error('Email required');
  const norm = email.toLowerCase().trim();
  const allowed = ADMIN_EMAILS.map(e=>e.toLowerCase().trim());
  if (!allowed.includes(norm))
    return {success:false, error:'Access denied.'};
  const code = String(Math.floor(100000 + Math.random()*900000));
  CacheService.getScriptCache().put('admin_otp_' + norm, code, 600); // 10 min
  GmailApp.sendEmail(email,
    'Your EPBL Job Tracker admin code',
    'Your admin login code is: ' + code +
    '\n\nThis code expires in 10 minutes. If you did not request this, you can ignore this email.');
  return {success:true};
}

function apiVerifyAdminOtp(b) {
  const {email, code} = b;
  if (!email || !code) throw new Error('Email and code required');
  const norm = email.toLowerCase().trim();
  const key = 'admin_otp_' + norm;
  const cached = CacheService.getScriptCache().get(key);
  if (!cached || cached !== String(code).trim())
    return {success:false, error:'Incorrect or expired code.'};
  CacheService.getScriptCache().remove(key); // one-time use
  return {success:true, email, role:'admin'};
}

function apiWorkerLogin(b) {
  const {mobile, pin} = b;
  if (!mobile||!pin) throw new Error('Mobile and PIN required');
  const data = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(SH_WORKERS).getDataRange().getValues();
  for (let i=1;i<data.length;i++) {
    if (String(data[i][2]).trim()===String(mobile).trim()) {
      const w=data[i];
      if (w[6]==='Pending') return {success:false, needsPin:true,
        workerId:w[0],name:w[1],mobile:w[2],dept1:w[3],dept2:w[4]||''};
      if (w[6]==='Inactive') return {success:false, error:'Account inactive.'};
      const hashed=hashPin(String(mobile).trim(),String(pin).trim());
      if (w[5]!==hashed) return {success:false, error:'Wrong PIN.'};
      return {success:true,workerId:w[0],name:w[1],mobile:w[2],dept1:w[3],dept2:w[4]||'',role:'worker'};
    }
  }
  return {success:false, error:'Mobile not registered. Contact admin.'};
}

function apiSetPin(b) {
  const {workerId, pin} = b;
  if (!workerId||!pin||pin.length!==4) throw new Error('WorkerID and 4-digit PIN required');
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_WORKERS);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++) {
    if (data[i][0]===workerId) {
      const hashed=hashPin(String(data[i][2]).trim(),String(pin).trim());
      sh.getRange(i+1,6).setValue(hashed);
      sh.getRange(i+1,7).setValue('Active');
      return {success:true,workerId,name:data[i][1],mobile:data[i][2],dept1:data[i][3],dept2:data[i][4]||''};
    }
  }
  throw new Error('Worker not found');
}

function apiChangePin(b) {
  const {workerId,oldPin,newPin} = b;
  if (!workerId||!oldPin||!newPin) throw new Error('Missing fields');
  if (newPin.length!==4) throw new Error('PIN must be 4 digits');
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_WORKERS);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++) {
    if (data[i][0]===workerId) {
      const oldH=hashPin(String(data[i][2]).trim(),String(oldPin).trim());
      if (data[i][5]!==oldH) return {success:false,error:'Old PIN wrong'};
      sh.getRange(i+1,6).setValue(hashPin(String(data[i][2]).trim(),String(newPin).trim()));
      return {success:true};
    }
  }
  throw new Error('Worker not found');
}

function apiResetPin(b) {
  const {workerId} = b;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_WORKERS);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++) {
    if (data[i][0]===workerId) {
      sh.getRange(i+1,6).setValue('');
      sh.getRange(i+1,7).setValue('Pending');
      return {success:true};
    }
  }
  throw new Error('Worker not found');
}

// ══════════════════════════════════════════
// WORKER MANAGEMENT
// ══════════════════════════════════════════

function apiCreateWorker(b) {
  const {name,mobile,dept1,dept2,adminEmail} = b;
  if (!name||!mobile||!dept1) throw new Error('Name, mobile, dept1 required');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_WORKERS);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++) {
    if (String(data[i][2]).trim()===String(mobile).trim())
      throw new Error('Mobile already registered');
  }
  const workerId='W'+Date.now().toString(36).toUpperCase();
  sh.appendRow([workerId,name,mobile,dept1,dept2||'','','Pending',new Date(),adminEmail||'']);
  return {success:true,workerId,name,mobile,status:'Pending'};
}

function apiGetAllWorkers(b) {
  return withBoardCache('all_workers', BOARD_CACHE_TTL, function(){ return _apiGetAllWorkers(b); });
}
function _apiGetAllWorkers(b) {
  const data = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(SH_WORKERS).getDataRange().getValues();
  const workers=[];
  for (let i=1;i<data.length;i++) {
    if(!data[i][0]) continue;
    workers.push({workerId:data[i][0],name:data[i][1],mobile:data[i][2],
                  dept1:data[i][3],dept2:data[i][4]||'',status:data[i][6]});
  }
  return {success:true,workers};
}

function apiGetWorkersByDept(b) {
  const {dept} = b;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = ss.getSheetByName(SH_WORKERS).getDataRange().getValues();
  const assignData = ss.getSheetByName(SH_ASSIGNMENTS).getDataRange().getValues();
  const busyWorkers={};
  for (let i=1;i<assignData.length;i++) {
    if (assignData[i][7]==='Active')
      busyWorkers[assignData[i][4]]={jobNo:assignData[i][1],seq:assignData[i][2]};
  }
  const workers=[];
  for (let i=1;i<data.length;i++) {
    if (data[i][6]!=='Active') continue; // Inactive workers (incl. Anupam) excluded
    if (data[i][3]===dept||data[i][4]===dept||dept==='Default') {
      const busy=busyWorkers[data[i][0]];
      workers.push({workerId:data[i][0],name:data[i][1],mobile:data[i][2],
                    dept1:data[i][3],dept2:data[i][4]||'',
                    status:busy?'Busy':'Free',busyOn:busy||null});
    }
  }
  return {success:true,dept,workers};
}

function apiToggleWorker(b) {
  const {workerId,active} = b;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_WORKERS);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++) {
    if (data[i][0]===workerId) {
      sh.getRange(i+1,7).setValue(active?'Active':'Inactive');
      return {success:true};
    }
  }
  throw new Error('Worker not found');
}

// ══════════════════════════════════════════
// JOB CREATION — NO AUTO-ASSIGN
// ══════════════════════════════════════════

function apiCreateJob(b) {
  const {jobNo,productType,customerName,startDate} = b;
  if (!jobNo||!productType||!customerName||!startDate) throw new Error('Missing fields');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const jobsSh  = ss.getSheetByName(SH_JOBS);
  const schedSh = ss.getSheetByName(SH_SCHEDULE);
  const procs   = getMasterFromSheet(productType, ss);
  if (!procs||!procs.length) throw new Error('Unknown type or empty Master: '+productType);

  const ex = jobsSh.getDataRange().getValues();
  for (let i=1;i<ex.length;i++) if(ex[i][0]===jobNo) throw new Error('Job '+jobNo+' already exists');

  jobsSh.appendRow([jobNo,productType,customerName,new Date(startDate),new Date(),'']);

  let cur=new Date(startDate); cur.setHours(WORK_START,0,0,0); cur=nextWorkDay(cur);
  const sched=[];
  for (const p of procs) {
    const pS=new Date(cur), pE=addWorkHrs(pS,p.dur);
    sched.push({...p,pS,pE});
    cur=new Date(pE);
    if(cur.getHours()>=WORK_START+WORK_HRS){
      cur.setDate(cur.getDate()+1);
      if(cur.getDay()===0) cur.setDate(cur.getDate()+1);
      cur.setHours(WORK_START,0,0,0);
    }
  }

  for (const r of sched) {
    schedSh.appendRow([jobNo,productType,customerName,r.seq,r.name,
                       r.worker,"'"+String(r.mobile),Number(r.dur),r.pS,r.pE,'','','','Pending','Not Started','']);
  }
  const lastRow = schedSh.getLastRow();
  const firstDataRow = lastRow - sched.length + 1;
  schedSh.getRange(firstDataRow, 8, sched.length, 1).setNumberFormat('0.0');

  // ── NO AUTO-ASSIGN on job creation ──
  // Admin will assign workers manually from Today Board

  const wa = {
    firstProcess: {
      workerName:'', mobile:'',
      jobNo, productType, customerName,
      seq:sched[0]?sched[0].seq:'', processName:sched[0]?sched[0].name:'',
      planStart:sched[0]?fmtD(sched[0].pS):'', planEnd:sched[0]?fmtD(sched[0].pE):''
    },
    totalProcesses:sched.filter(p=>!p.isInsp).length,
    totalInspections:sched.filter(p=>p.isInsp).length
  };

  // Build dept-wise WA messages
  const deptGroups={};
  for (const r of sched) {
    if (r.isInsp) continue;
    const dept = r.name || 'General';
    if (!deptGroups[dept]) deptGroups[dept]={count:0,firstProc:null,lastProc:null};
    deptGroups[dept].count++;
    if (!deptGroups[dept].firstProc) deptGroups[dept].firstProc={seq:r.seq,name:r.name,start:fmtD(r.pS),end:fmtD(r.pE)};
    deptGroups[dept].lastProc={seq:r.seq,name:r.name,start:fmtD(r.pS),end:fmtD(r.pE)};
  }

  try { createSummaryRow(jobNo, productType, customerName, sched, ss); } catch(se) {}
  return {success:true,jobNo,productType,customerName,
          totalProcessRows:sched.length,waData:wa,waMessages:deptGroups};
}

// ══════════════════════════════════════════
// ASSIGNMENT
// ══════════════════════════════════════════

function apiAssignWorker(b) {
  const {jobNo,seq,dept,workerId,workerName,adminEmail,forceParallel} = b;
  if (!jobNo||!seq||!workerId) throw new Error('Missing fields');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const assignSh = ss.getSheetByName(SH_ASSIGNMENTS);
  const assignData = assignSh.getDataRange().getValues();

  let busyOn = null;
  for (let i=1;i<assignData.length;i++) {
    if (assignData[i][4]===workerId&&assignData[i][7]==='Active') {
      busyOn = {jobNo:assignData[i][1], seq:assignData[i][2]};
      break;
    }
  }

  if (busyOn && !forceParallel) {
    return {success:false, busy:true,
            busyJobNo:busyOn.jobNo, busySeq:busyOn.seq,
            workerName, workerId,
            message:workerName+' is busy on Job '+busyOn.jobNo+' Seq '+busyOn.seq};
  }

  // ── DUPLICATE CHECK: if same worker already Active on this Job+Seq, skip ──
  for (let i=1;i<assignData.length;i++) {
    if (String(assignData[i][1])===String(jobNo) &&
        String(assignData[i][2])===String(seq) &&
        assignData[i][4]===workerId &&
        assignData[i][7]==='Active') {
      return {success:true, assignId:assignData[i][0], alreadyAssigned:true,
              message:workerName+' already assigned to this seq'};
    }
  }

  // Mark any existing Active assignments for this Job+Seq as Reassigned
  if (!forceParallel) {
    for (let i=1;i<assignData.length;i++) {
      if (String(assignData[i][1])===String(jobNo) &&
          String(assignData[i][2])===String(seq) &&
          assignData[i][7]==='Active') {
        assignSh.getRange(i+1,8).setValue('Reassigned');
      }
    }
  }

  const assignedBy = forceParallel ? (adminEmail||'Admin')+' [Parallel]' : (adminEmail||'');
  const assignId='A'+Date.now().toString(36).toUpperCase();
  assignSh.appendRow([assignId,jobNo,seq,dept||'Default',workerId,workerName,
                      new Date(),'Active',assignedBy,'']);

  const schedData = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
  let procName='',planStart='',planEnd='',mobile='';
  for (let i=1;i<schedData.length;i++) {
    if (String(schedData[i][0])===String(jobNo)&&schedData[i][3]==seq) {
      procName=schedData[i][4]; planStart=fmtDT(new Date(schedData[i][8]));
      planEnd=fmtDT(new Date(schedData[i][9])); break;
    }
  }
  const wData = ss.getSheetByName(SH_WORKERS).getDataRange().getValues();
  for (let i=1;i<wData.length;i++) {
    if (wData[i][0]===workerId) { mobile=wData[i][2]; break; }
  }
  return {success:true, assignId, isParallel:!!forceParallel,
          whatsapp:{mobile,workerName,jobNo,seq,procName,planStart,planEnd}};
}

function apiReassignWorker(b) {
  const {jobNo,seq,dept,oldWorkerId,newWorkerId,newWorkerName,adminEmail} = b;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_ASSIGNMENTS);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++) {
    if (data[i][1]===jobNo&&data[i][2]==seq&&data[i][4]===oldWorkerId&&data[i][7]==='Active')
      sh.getRange(i+1,8).setValue('Reassigned');
  }
  return apiAssignWorker({jobNo,seq,dept,workerId:newWorkerId,workerName:newWorkerName,adminEmail});
}

function apiForceReassign(b) {
  const {jobNo,seq,dept,oldWorkerId,newWorkerId,newWorkerName,adminEmail} = b;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_ASSIGNMENTS);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++) {
    if (data[i][1]===jobNo&&data[i][2]==seq&&data[i][4]===oldWorkerId)
      sh.getRange(i+1,8).setValue('Reassigned');
  }
  const schedSh = ss.getSheetByName(SH_SCHEDULE);
  const schedData = schedSh.getDataRange().getValues();
  for (let i=1;i<schedData.length;i++) {
    if (String(schedData[i][0])===String(jobNo)&&schedData[i][3]==seq) {
      schedSh.getRange(i+1,11).setValue('');
      schedSh.getRange(i+1,12).setValue('');
      schedSh.getRange(i+1,13).setValue('');
      schedSh.getRange(i+1,14).setValue('Pending');
    }
  }
  return apiAssignWorker({jobNo,seq,dept,workerId:newWorkerId,workerName:newWorkerName,adminEmail});
}

// ══════════════════════════════════════════
// STAMP START — Admin only
// Worker stampStart is BLOCKED at API level
// ══════════════════════════════════════════

function apiStampStart(b) {
  const {jobNo,seq,workerId,adminEmail} = b;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_SCHEDULE);
  const data = sh.getDataRange().getValues();
  const now = new Date();

  // Block if called by worker (no adminEmail)
  if (!adminEmail && workerId) {
    return {success:false, error:'Only admin can start a process.'};
  }

  for (let i=1;i<data.length;i++) {
    if (String(data[i][0])===String(jobNo) && String(data[i][3])===String(seq)) {
      if (data[i][13]==='In Progress' && data[i][10])
        return {success:false, error:'Already started'};
      sh.getRange(i+1,11).setValue(now);
      sh.getRange(i+1,14).setValue('In Progress');
      sh.getRange(i+1,15).setValue('In Progress — On Time');
      sh.getRange(i+1,1,1,15).setBackground('#fdba74').setFontColor('#000000');
      SpreadsheetApp.flush();
      return {success:true, actStart:fmtDT(now)};
    }
  }
  throw new Error('Process not found');
}

// ══════════════════════════════════════════
// STAMP STOP — Admin only
// Worker stampStop is BLOCKED at API level
// No auto-assign after stop
// ══════════════════════════════════════════

function apiStampStop(b) {
  const {jobNo,seq,workerId,adminEmail} = b;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_SCHEDULE);
  const data = sh.getDataRange().getValues();
  const now = new Date();

  // Block if called by worker (no adminEmail)
  if (!adminEmail && workerId) {
    return {success:false, error:'Only admin can stop a process.'};
  }

  for (let i=1;i<data.length;i++) {
    if (String(data[i][0])===String(jobNo)&&String(data[i][3])===String(seq)) {
      if (data[i][13]==='Done') return {success:false,error:'Already completed'};
      if (!data[i][10]) {
        sh.getRange(i+1,11).setValue(new Date(data[i][8]));
      }
      const pE=new Date(data[i][9]);
      const aS=data[i][10]?new Date(data[i][10]):new Date(data[i][8]);
      const delay=calcWorkingHrsDelay(pE,now);
      sh.getRange(i+1,12).setValue(now);
      sh.getRange(i+1,13).setValue(delay);
      sh.getRange(i+1,14).setValue('Pending Inspection');
      sh.getRange(i+1,15).setValue('Completed — Pending Inspection');
      sh.getRange(i+1,1,1,15).setBackground('#fde68a').setFontColor('#000000');
      SpreadsheetApp.flush();

      const procName = data[i][4];
      const isInspProc = procName==='INSPECTION';
      const workerName = data[i][5]||'Unknown';

      if (!isInspProc) {
        const inspId = 'I'+Date.now().toString(36).toUpperCase();
        try {
          const inspSh = ss.getSheetByName(SH_INSPECTIONS);
          inspSh.appendRow([inspId,jobNo,seq,procName,workerName,now,'','Pending','','']);

          const assignSh = ss.getSheetByName(SH_ASSIGNMENTS);
          const assignData = assignSh.getDataRange().getValues();
          for (let j=1;j<assignData.length;j++) {
            if (String(assignData[j][1])===String(jobNo)&&String(assignData[j][2])===String(seq)&&assignData[j][7]==='Active')
              assignSh.getRange(j+1,8).setValue('Awaiting Inspection');
          }
        } catch (writeErr) {
          // Compensate: an inspection record couldn't be created after the
          // schedule row was already marked "Pending Inspection" — revert it
          // instead of leaving an orphaned row nobody can find on the Inspect tab.
          sh.getRange(i+1,11).setValue(data[i][10]||'');
          sh.getRange(i+1,12).setValue('');
          sh.getRange(i+1,13).setValue('');
          sh.getRange(i+1,14).setValue('In Progress');
          sh.getRange(i+1,15).setValue('In Progress — On Time');
          sh.getRange(i+1,1,1,15).setBackground('#fdba74').setFontColor('#000000');
          throw new Error('Could not record inspection — process reverted to In Progress. Please try Stop again. ('+writeErr.message+')');
        }

        // Notify BOTH inspectors
        try {
          const subject = 'Inspection Required — Job '+jobNo+' Seq '+seq;
          const body = 'Job: '+jobNo+'\nProcess: '+procName+'\nCompleted by: '+workerName+
                       '\nAt: '+fmtDT(now)+'\nDelay: '+(delay>0?delay+' hrs late':'On time')+
                       '\n\nApp: https://vkv-coder.github.io/EPBL-JOB/';
          GmailApp.sendEmail(NOTIFY_EMAIL, subject, body);
        } catch(emailErr) { Logger.log('Email error: '+emailErr.message); }

        // Return both inspector WhatsApp details
        const inspectorMsgs = INSPECTORS.map(insp=>({
          name:insp.name, mobile:insp.mobile,
          message:'Inspect: Job '+jobNo+' Seq '+seq+' '+procName.substring(0,40)+
                  ' | Done by '+workerName+' | Stopped by Admin'
        }));

        // ── NO AUTO-ASSIGN ──
        return {success:true, actEnd:fmtDT(now), delayHrs:delay,
                inspectionPending:true, inspId,
                whatsappInspectors: inspectorMsgs};
      } else {
        sh.getRange(i+1,14).setValue('Done');
        // ── NO AUTO-ASSIGN ──
        updateSummaryOnComplete(jobNo, ss);
        return {success:true, actEnd:fmtDT(now), delayHrs:delay, inspectionDone:true, nextAssigned:null};
      }
    }
  }
  throw new Error('Process not found');
}

// ══════════════════════════════════════════
// TODAY / TOMORROW BOARDS
// ══════════════════════════════════════════

function apiGetTodayBoard(b) {
  return withBoardCache('today_board', BOARD_CACHE_TTL, function(){ return _apiGetTodayBoard(b); });
}
function _apiGetTodayBoard(b) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedData = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
  const assignSh  = ss.getSheetByName(SH_ASSIGNMENTS);
  let assignData  = assignSh.getDataRange().getValues();
  const now=new Date(), todayStart=new Date(), todayEnd=new Date();
  todayStart.setHours(0,0,0,0); todayEnd.setHours(23,59,59,999);

  function buildAssignMap(data) {
    const map={};
    for (let i=1;i<data.length;i++) {
      if (data[i][7]==='Active'||data[i][7]==='Awaiting Inspection') {
        const key=data[i][1]+'|'+data[i][2];
        if(!map[key]) map[key]=[];
        map[key].push({workerId:data[i][4],workerName:data[i][5],
                       status:data[i][7],isManual:data[i][9]==='Y'});
      }
    }
    return map;
  }
  let assignMap = buildAssignMap(assignData);

  const manualSeqs=new Set();
  for (let i=1;i<assignData.length;i++) {
    if (assignData[i][7]==='Active' && assignData[i][9]==='Y')
      manualSeqs.add(assignData[i][1]+'|'+assignData[i][2]);
  }

  const jobSeqStatus={};
  for (let i=1;i<schedData.length;i++) {
    const r=schedData[i]; if(!r[0]) continue;
    const jNo=String(r[0]), seq=parseInt(r[3]);
    if(!jobSeqStatus[jNo]) jobSeqStatus[jNo]={};
    jobSeqStatus[jNo][seq]=r[13];
  }

  function isPredecessorReady(jobNo, seq) {
    const seqStatuses = jobSeqStatus[jobNo];
    if (!seqStatuses) return true;
    const seqs = Object.keys(seqStatuses).map(Number).sort((a,b)=>a-b);
    const prevSeqs = seqs.filter(s => s < seq);
    if (!prevSeqs.length) return true;
    for (let i=prevSeqs.length-1; i>=0; i--) {
      const ps = prevSeqs[i];
      for (let j=1;j<schedData.length;j++) {
        if (String(schedData[j][0])===String(jobNo) && parseInt(schedData[j][3])===ps) {
          if (schedData[j][4]==='INSPECTION') continue;
          const prevStatus = schedData[j][13];
          return prevStatus==='Done' || prevStatus==='Pending Inspection';
        }
      }
    }
    return true;
  }

  const board=[];
  for (let i=1;i<schedData.length;i++) {
    const r=schedData[i]; if(!r[0]) continue;
    if (r[4]==='INSPECTION') continue;
    if (r[13]==='Pending Inspection') continue;
    if (r[13]==='Done') continue;

    const planStart=new Date(r[8]), status=r[13];
    const isActive  = status==='In Progress';
    const isRework  = status==='Rework';
    const isOverdue = (status==='Pending'||isRework) && planStart<todayStart;
    const isToday   = (status==='Pending'||isRework) && planStart>=todayStart && planStart<=todayEnd;

    const key=String(r[0])+'|'+String(r[3]);
    const isManualAssigned = manualSeqs.has(key);

    if (!isActive && !isManualAssigned && !isOverdue && !isToday) continue;
    if (!isActive && !isManualAssigned && (isOverdue||isToday)) {
      if (!isPredecessorReady(String(r[0]), parseInt(r[3]))) continue;
    }

    board.push({
      jobNo:r[0],productType:r[1],customer:r[2],
      seq:r[3],processName:r[4],defaultWorker:r[5],dept:'Default',durHrs:r[7],
      planStart:fmtDT(new Date(r[8])),planEnd:fmtDT(new Date(r[9])),
      actStart:r[10]?fmtDT(new Date(r[10])):'',
      status,isOverdue,isToday,isActive,isRework,isPendInsp:false,
      isInspection:false,isManualAssigned,
      assignedWorkers:assignMap[key]||[]
    });
  }

  board.sort((a,b)=>{
    if(a.isActive&&!b.isActive) return -1;
    if(!a.isActive&&b.isActive) return 1;
    if(a.isOverdue&&!b.isOverdue) return -1;
    if(!a.isOverdue&&b.isOverdue) return 1;
    return new Date(a.planStart)-new Date(b.planStart);
  });

  return {success:true,board,total:board.length,
          overdue:board.filter(x=>x.isOverdue).length,
          today:board.filter(x=>x.isToday).length,
          active:board.filter(x=>x.isActive).length,
          pendingInspection:0};
}

function apiGetTomorrowBoard(b) {
  return withBoardCache('tomorrow_board', BOARD_CACHE_TTL, function(){ return _apiGetTomorrowBoard(b); });
}
function _apiGetTomorrowBoard(b) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedData = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
  const assignData = ss.getSheetByName(SH_ASSIGNMENTS).getDataRange().getValues();
  const tomorrow=new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  const tomStart=new Date(tomorrow); tomStart.setHours(0,0,0,0);
  const tomEnd=new Date(tomorrow); tomEnd.setHours(23,59,59,999);
  const todayStart=new Date(); todayStart.setHours(0,0,0,0);

  const assignMap={};
  for (let i=1;i<assignData.length;i++) {
    if (assignData[i][7]==='Active'||assignData[i][7]==='Awaiting Inspection') {
      const key=assignData[i][1]+'|'+assignData[i][2];
      if(!assignMap[key]) assignMap[key]=[];
      assignMap[key].push({workerId:assignData[i][4],workerName:assignData[i][5]});
    }
  }

  const manualSeqs=new Set();
  for (let i=1;i<assignData.length;i++) {
    if (assignData[i][7]==='Active' && assignData[i][9]==='Y')
      manualSeqs.add(assignData[i][1]+'|'+assignData[i][2]);
  }

  const jobSeqStatus={};
  for (let i=1;i<schedData.length;i++) {
    const r=schedData[i]; if(!r[0]) continue;
    if(!jobSeqStatus[String(r[0])]) jobSeqStatus[String(r[0])]=[];
    jobSeqStatus[String(r[0])].push({seq:parseInt(r[3]), status:r[13], name:r[4]});
  }

  function isPredecessorReady(jobNo, seq) {
    const rows = jobSeqStatus[jobNo];
    if (!rows) return true;
    const prevRows = rows.filter(r => r.seq < seq && r.name !== 'INSPECTION')
                        .sort((a,b)=>b.seq-a.seq);
    if (!prevRows.length) return true;
    const prev = prevRows[0];
    return prev.status==='Done' || prev.status==='Pending Inspection' || prev.status==='In Progress';
  }

  const board=[];
  for (let i=1;i<schedData.length;i++) {
    const r=schedData[i]; if(!r[0]) continue;
    if (r[4]==='INSPECTION') continue;
    if (r[13]==='Done' || r[13]==='Pending Inspection') continue;

    const planStart=new Date(r[8]), status=r[13];
    const isTomorrow = (status==='Pending'||status==='In Progress') &&
                       planStart>=tomStart && planStart<=tomEnd;
    const isCarryFwd = (status==='Pending'||status==='In Progress'||status==='Rework') &&
                       planStart<todayStart;
    const isManualAssigned = manualSeqs.has(String(r[0])+'|'+String(r[3]));

    if (!isTomorrow && !isCarryFwd && !isManualAssigned) continue;
    if (!isManualAssigned && status==='Pending') {
      if (!isPredecessorReady(String(r[0]), parseInt(r[3]))) continue;
    }

    const key=r[0]+'|'+r[3];
    board.push({
      jobNo:r[0],productType:r[1],customer:r[2],
      seq:r[3],processName:r[4],defaultWorker:r[5],dept:'Default',durHrs:r[7],
      planStart:fmtDT(new Date(r[8])),planEnd:fmtDT(new Date(r[9])),
      status,isTomorrow,isCarryFwd,isManualAssigned,
      isInspection:false,
      assignedWorkers:assignMap[key]||[]
    });
  }

  board.sort((a,b)=>{
    if(a.isCarryFwd&&!b.isCarryFwd) return -1;
    if(!a.isCarryFwd&&b.isCarryFwd) return 1;
    return new Date(a.planStart)-new Date(b.planStart);
  });

  return {success:true,board,total:board.length,
          tomorrow:board.filter(x=>x.isTomorrow).length,
          carryFwd:board.filter(x=>x.isCarryFwd).length,
          unassigned:board.filter(x=>!x.assignedWorkers.length).length};
}

// ══════════════════════════════════════════
// WEEK BOARD — next 7 days plan + running-late backlog
// isRunningDelayed: In Progress, past its PlanEnd (actively late)
// isOverdueUnstarted: Pending/Rework, PlanStart before today (never started)
// Everything else in the 7-day window is upcoming/plannable
// ══════════════════════════════════════════

function apiGetWeekBoard(b) {
  return withBoardCache('week_board', BOARD_CACHE_TTL, function(){ return _apiGetWeekBoard(b); });
}
function _apiGetWeekBoard(b) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedData = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
  const assignData = ss.getSheetByName(SH_ASSIGNMENTS).getDataRange().getValues();
  const now = new Date();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const weekEnd = new Date(todayStart); weekEnd.setDate(weekEnd.getDate()+7);

  const assignMap = {};
  for (let i=1;i<assignData.length;i++) {
    if (assignData[i][7]==='Active'||assignData[i][7]==='Awaiting Inspection') {
      const key=assignData[i][1]+'|'+assignData[i][2];
      if(!assignMap[key]) assignMap[key]=[];
      assignMap[key].push({workerId:assignData[i][4],workerName:assignData[i][5]});
    }
  }

  const board=[];
  for (let i=1;i<schedData.length;i++) {
    const r=schedData[i]; if(!r[0]) continue;
    if (r[4]==='INSPECTION') continue;
    if (r[13]==='Done') continue;
    if (r[13]==='Pending Inspection') continue;

    const planStart=new Date(r[8]), planEnd=new Date(r[9]), status=r[13];
    const isRunningDelayed = status==='In Progress' && now>planEnd;
    const isOverdueUnstarted = (status==='Pending'||status==='Rework') && planStart<todayStart;
    const inWeekWindow = planStart>=todayStart && planStart<weekEnd;

    if (!isRunningDelayed && !isOverdueUnstarted && !inWeekWindow) continue;

    const key=r[0]+'|'+r[3];
    board.push({
      jobNo:r[0],productType:r[1],customer:r[2],
      seq:r[3],processName:r[4],dept:'Default',durHrs:r[7],
      planStart:fmtDT(planStart),planEnd:fmtDT(planEnd),
      status,isRunningDelayed,isOverdueUnstarted,
      delayHrs: isRunningDelayed ? calcWorkingHrsDelay(planEnd,now) : 0,
      isInspection:false,
      assignedWorkers:assignMap[key]||[]
    });
  }

  board.sort((a,b)=>{
    if(a.isRunningDelayed&&!b.isRunningDelayed) return -1;
    if(!a.isRunningDelayed&&b.isRunningDelayed) return 1;
    if(a.isOverdueUnstarted&&!b.isOverdueUnstarted) return -1;
    if(!a.isOverdueUnstarted&&b.isOverdueUnstarted) return 1;
    return new Date(a.planStart)-new Date(b.planStart);
  });

  return {success:true, board, total:board.length,
          runningDelayed: board.filter(x=>x.isRunningDelayed).length,
          overdueUnstarted: board.filter(x=>x.isOverdueUnstarted).length,
          upcoming: board.filter(x=>!x.isRunningDelayed&&!x.isOverdueUnstarted).length};
}

function apiGetUnassignedToday(b) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedData = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
  const assignData = ss.getSheetByName(SH_ASSIGNMENTS).getDataRange().getValues();
  const todayStart=new Date(); todayStart.setHours(0,0,0,0);
  const todayEnd=new Date(); todayEnd.setHours(23,59,59,999);
  const assignedKeys=new Set();
  for (let i=1;i<assignData.length;i++) {
    if (assignData[i][7]==='Active') assignedKeys.add(assignData[i][1]+'|'+assignData[i][2]);
  }
  const unassigned=[];
  for (let i=1;i<schedData.length;i++) {
    const r=schedData[i]; if(!r[0]) continue;
    const planStart=new Date(r[8]), status=r[13];
    const isOverdue=(status==='Pending')&&planStart<todayStart;
    const isToday=(status==='Pending')&&planStart>=todayStart&&planStart<=todayEnd;
    if (!isOverdue&&!isToday) continue;
    const key=r[0]+'|'+r[3];
    if (!assignedKeys.has(key)) {
      unassigned.push({
        jobNo:r[0],productType:r[1],customer:r[2],
        seq:r[3],processName:r[4],defaultWorker:r[5],
        defaultMobile:r[6],durHrs:r[7],
        planStart:fmtDT(new Date(r[8])),planEnd:fmtDT(new Date(r[9])),
        isOverdue
      });
    }
  }
  return {success:true,unassigned,count:unassigned.length};
}

// ══════════════════════════════════════════
// WORKER JOB VIEWS (read-only — no start/stop)
// ══════════════════════════════════════════

function apiGetMyJobs(b) {
  const {workerId} = b;
  if (!workerId) throw new Error('workerId required');
  // Cached — this is a worker's first screen after every login/tap, so an
  // uncached full-sheet read here was the single biggest load-time cost.
  return withBoardCache('myjobs_'+workerId, BOARD_CACHE_TTL, () => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const assignData = ss.getSheetByName(SH_ASSIGNMENTS).getDataRange().getValues();
    const myAssignments=[];
    for (let i=1;i<assignData.length;i++) {
      if (assignData[i][4]===workerId&&(assignData[i][7]==='Active'||assignData[i][7]==='Awaiting Inspection'))
        myAssignments.push({jobNo:String(assignData[i][1]),seq:String(assignData[i][2])});
    }
    if (!myAssignments.length) return {success:true,jobs:[]};
    const schedData = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
    const now=new Date(), jobMap={};
    for (const a of myAssignments) {
      for (let i=1;i<schedData.length;i++) {
        const r=schedData[i];
        if (String(r[0])===String(a.jobNo)&&String(r[3])===String(a.seq)) {
          if (!jobMap[a.jobNo]) jobMap[a.jobNo]={jobNo:a.jobNo,type:r[1],cust:r[2],procs:[],lastPE:new Date(0)};
          const pe=new Date(r[9]); if(pe>jobMap[a.jobNo].lastPE) jobMap[a.jobNo].lastPE=pe;
          jobMap[a.jobNo].procs.push({seq:r[3],pS:r[8],pE:r[9],aE:r[11],status:r[13]});
        }
      }
    }
    const today=new Date(); today.setHours(0,0,0,0);
    const jobs=[];
    for (const j of Object.values(jobMap)) {
      const allDone=j.procs.every(p=>p.status==='Done');
      if(allDone&&j.lastPE<today) continue;
      let tot=0,act=0,fut=0;
      for (const p of j.procs) {
        tot++;
        if(p.status==='In Progress') act++;
        else if(p.status==='Pending'&&new Date(p.pS)>now) fut++;
      }
      const last=j.procs[j.procs.length-1];
      const lPE=new Date(last.pE),lAE=last.aE?new Date(last.aE):null;
      const started=j.procs.some(p=>p.status==='Done'||p.status==='In Progress');
      const colour=!started?'grey':(lAE&&lAE>lPE)||(now>lPE&&!lAE)?'red':'green';
      const first=j.procs[0];
      jobs.push({jobNo:j.jobNo,productType:j.type,customer:j.cust,colour,
                 total:tot,active:act,future:fut,
                 firstProcDate:fmtD(new Date(first.pS)),
                 lastProcDate:fmtD(lPE),
                 progress:Math.round(j.procs.filter(p=>p.status==='Done').length/tot*100)});
    }
    return {success:true,jobs};
  });
}

function apiGetJobProcs(b) {
  const {jobNo,seq,workerId} = b;
  if (!jobNo) throw new Error('jobNo required');
  // Cached — the very next call after getMyJobs (every job tap), same
  // full-sheet-read cost, same fix.
  return withBoardCache('jobprocs_'+jobNo+'_'+(workerId||'all'), BOARD_CACHE_TTL, () => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const data = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
    const now=new Date(), procs=[];
    let assignedSeqs=null;
    if (workerId) {
      assignedSeqs=new Set();
      const assignData=ss.getSheetByName(SH_ASSIGNMENTS).getDataRange().getValues();
      for (let i=1;i<assignData.length;i++) {
        if (assignData[i][4]===workerId &&
            String(assignData[i][1])===String(jobNo) &&
            (assignData[i][7]==='Active'||assignData[i][7]==='Awaiting Inspection'))
          assignedSeqs.add(String(assignData[i][2]));
      }
    }
    for (let i=1;i<data.length;i++) {
      const r=data[i]; if(String(r[0])!==String(jobNo)) continue;
      if (assignedSeqs&&!assignedSeqs.has(String(r[3]))) continue;
      const pS=new Date(r[8]),pE=new Date(r[9]);
      const aS=r[10]?new Date(r[10]):null, aE=r[11]?new Date(r[11]):null;
      const st=r[13];
      const colour=st==='Done'?'green':st==='In Progress'?'orange':
                   st==='Pending Inspection'?'purple':st==='Rework'?'red':
                   now>pS?'red':'grey';
      procs.push({seq:r[3],name:r[4],durHrs:r[7],defaultWorker:r[5],
                 planStart:fmtDT(pS),planEnd:fmtDT(pE),
                 actStart:aS?fmtDT(aS):'',actEnd:aE?fmtDT(aE):'',
                 delayHrs:r[12]||'',status:st,colour,
                 isInspection:r[4]==='INSPECTION',remarks:r[15]||''});
    }
    procs.sort((a,b)=>a.seq-b.seq);
    return {success:true,jobNo,procs};
  });
}

function apiSaveRemark(b) {
  const {jobNo,seq,remark} = b;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_SCHEDULE);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++) {
    if (String(data[i][0])===String(jobNo)&&data[i][3]==seq) {
      sh.getRange(i+1,16).setValue(remark);
      return {success:true};
    }
  }
  throw new Error('Process not found');
}

function apiSaveAdminNote(b) {
  const {jobNo, seq, note, adminEmail} = b;
  if (!jobNo||!seq) throw new Error('jobNo and seq required');
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_SCHEDULE);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++) {
    if (String(data[i][0])===String(jobNo) && data[i][3]==seq) {
      const existing = data[i][15]||'';
      const newNote = existing ? existing+'\n'+note : note;
      sh.getRange(i+1,16).setValue(newNote);
      return {success:true, note:newNote};
    }
  }
  throw new Error('Process not found');
}

function apiSearchJobs(b) {
  const {jobNo, status} = b;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedData = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
  const assignData = ss.getSheetByName(SH_ASSIGNMENTS).getDataRange().getValues();
  const inspData   = ss.getSheetByName(SH_INSPECTIONS).getDataRange().getValues();
  const now = new Date();

  const assignMap = {};
  for (let i=1;i<assignData.length;i++) {
    if (assignData[i][7]==='Active'||assignData[i][7]==='Awaiting Inspection') {
      const key = assignData[i][1]+'|'+assignData[i][2];
      assignMap[key] = assignData[i][5];
    }
  }

  const rejectMap = {};
  for (let i=1;i<inspData.length;i++) {
    if (inspData[i][7]==='Rejected') {
      const key = String(inspData[i][1])+'|'+String(inspData[i][2]);
      rejectMap[key] = inspData[i][8]||'No reason given';
    }
  }

  const results = [];
  for (let i=1;i<schedData.length;i++) {
    const r = schedData[i]; if (!r[0]) continue;
    if (r[4]==='INSPECTION' && r[13]==='Pending') continue;
    if (jobNo && !String(r[0]).toLowerCase().includes(jobNo.toLowerCase())) continue;
    const rawStatus = r[13];
    const planStart = new Date(r[8]);
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    let displayStatus = rawStatus;
    if (rawStatus==='Pending' && planStart<todayStart) displayStatus='Overdue';
    if (rawStatus==='Pending' && planStart>=todayStart) displayStatus='Not Started';
    if (rawStatus==='Rework') displayStatus='Rework';
    if (status && status!=='All') {
      const isDelayed = (rawStatus==='Pending'&&planStart<todayStart)||
                        (rawStatus==='In Progress'&&now>new Date(r[9]))||
                        (rawStatus==='Done'&&(r[12]||0)>0);
      if (status==='Delayed' && !isDelayed) continue;
      if (status==='Not Started' && !(rawStatus==='Pending'&&planStart>=todayStart)) continue;
      if (status==='In Progress' && rawStatus!=='In Progress') continue;
      if (status==='Completed' && rawStatus!=='Done') continue;
      if (status==='Pending Inspection' && rawStatus!=='Pending Inspection') continue;
      if (status==='Rework' && rawStatus!=='Rework') continue;
    }
    const key = r[0]+'|'+r[3];
    results.push({
      jobNo:r[0], productType:r[1], customer:r[2],
      seq:r[3], processName:r[4], defaultWorker:r[5], durHrs:r[7],
      planStart:fmtDT(new Date(r[8])), planEnd:fmtDT(new Date(r[9])),
      actStart:r[10]?fmtDT(new Date(r[10])):'',
      actEnd:r[11]?fmtDT(new Date(r[11])):'',
      delayHrs:r[12]||0, status:rawStatus, displayStatus,
      assignedWorker:assignMap[key]||'', notes:r[15]||'',
      rejectRemark: rejectMap[key]||''
    });
  }
  return {success:true, results, count:results.length};
}

// ══════════════════════════════════════════
// ADMIN VIEWS
// ══════════════════════════════════════════

function apiAdminJobs() {
  return withBoardCache('admin_jobs', BOARD_CACHE_TTL, function(){ return _apiAdminJobs(); });
}
function _apiAdminJobs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedData = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
  const now=new Date(), jm={};
  for (let i=1;i<schedData.length;i++) {
    const r=schedData[i],jNo=r[0]; if(!jNo) continue;
    // ── Skip INSPECTION rows from all counts ──
    if(r[4]==='INSPECTION') continue;
    if(!jm[jNo]) jm[jNo]={jobNo:jNo,type:r[1],cust:r[2],total:0,done:0,overdue:0,pendInsp:0};
    const j=jm[jNo],st=r[13];
    j.total++;
    if(st==='Done') j.done++;
    else if(st==='Pending Inspection') j.pendInsp++;
    else if((st==='Pending'||st==='Rework')&&now>new Date(r[8])) j.overdue++;
  }
  // ── Exclude fully completed jobs from All Jobs list ──
  return {success:true,jobs:Object.values(jm)
    .filter(j=>j.done < j.total)
    .map(j=>({...j,progress:Math.round(j.done/j.total*100)}))};
}

function apiGetWorkerBoard(b) {
  return withBoardCache('worker_board', BOARD_CACHE_TTL, function(){ return _apiGetWorkerBoard(b); });
}
function _apiGetWorkerBoard(b) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const workerData  = ss.getSheetByName(SH_WORKERS).getDataRange().getValues();
  const assignData  = ss.getSheetByName(SH_ASSIGNMENTS).getDataRange().getValues();
  const schedData   = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
  const now=new Date();

  const schedMap={};
  for (let i=1;i<schedData.length;i++) {
    const r=schedData[i]; if(!r[0]) continue;
    schedMap[r[0]+'|'+r[3]]={
      processName:r[4], status:r[13],
      planStart:fmtDT(new Date(r[8])), planEnd:fmtDT(new Date(r[9])),
      actStart:r[10]?fmtDT(new Date(r[10])):'', delayHrs:r[12]||0,
      customer:r[2], productType:r[1],
      isInspection:r[4]==='INSPECTION'
    };
  }

  const assignByWorker={};
  for (let i=1;i<assignData.length;i++) {
    const wId=assignData[i][4]; if(!wId) continue;
    const aStatus=assignData[i][7];
    if (aStatus!=='Active'&&aStatus!=='Awaiting Inspection') continue;
    const key=assignData[i][1]+'|'+assignData[i][2];
    const sched=schedMap[key]||{};
    if (sched.isInspection) continue;
    if(!assignByWorker[wId]) assignByWorker[wId]={};
    if(assignByWorker[wId][key]) continue;
    assignByWorker[wId][key]={
      jobNo:assignData[i][1], seq:assignData[i][2],
      assignStatus:aStatus,
      processName:sched.processName||'',
      status:sched.status||'',
      planStart:sched.planStart||'',
      planEnd:sched.planEnd||'',
      actStart:sched.actStart||'',
      delayHrs:sched.delayHrs||0,
      customer:sched.customer||'',
      productType:sched.productType||''
    };
  }

  const board=[];
  for (let i=1;i<workerData.length;i++) {
    const w=workerData[i]; if(!w[0]||w[6]==='Inactive') continue;
    const assignments = Object.values(assignByWorker[w[0]]||{});
    const isFree = assignments.length===0;
    const isDelayed = assignments.some(a=>{
      if(a.status==='In Progress'){
        const pE=a.planEnd?new Date(a.planEnd.replace(/(\d{2})\/(\d{2})\/(\d{4})/,'$3-$2-$1')):null;
        return pE&&now>pE;
      }
      if(a.status==='Pending'){
        const pS=a.planStart?new Date(a.planStart.replace(/(\d{2})\/(\d{2})\/(\d{4})/,'$3-$2-$1')):null;
        return pS&&now>pS;
      }
      return false;
    });
    board.push({
      workerId:w[0], name:w[1], mobile:w[2],
      dept1:w[3], dept2:w[4]||'',
      workerStatus:w[6], isFree, isDelayed, assignments
    });
  }

  board.sort((a,b)=>{
    if(a.isDelayed&&!b.isDelayed) return -1;
    if(!a.isDelayed&&b.isDelayed) return 1;
    if(!a.isFree&&b.isFree) return -1;
    if(a.isFree&&!b.isFree) return 1;
    return a.name.localeCompare(b.name);
  });

  return {success:true, board, total:board.length,
          free:board.filter(w=>w.isFree).length,
          busy:board.filter(w=>!w.isFree).length,
          delayed:board.filter(w=>w.isDelayed).length};
}

function apiGetWorkerHistory(b) {
  const {workerId} = b;
  if (!workerId) throw new Error('workerId required');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const assignData = ss.getSheetByName(SH_ASSIGNMENTS).getDataRange().getValues();
  const schedData  = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
  const myAssignments=[];
  for (let i=1;i<assignData.length;i++) {
    if (assignData[i][4]===workerId)
      myAssignments.push({jobNo:assignData[i][1],seq:assignData[i][2],assignStatus:assignData[i][7]});
  }
  const history=[];
  for (const a of myAssignments) {
    for (let i=1;i<schedData.length;i++) {
      const r=schedData[i];
      if (String(r[0])===String(a.jobNo)&&String(r[3])===String(a.seq)) {
        const pE=new Date(r[9]), aE=r[11]?new Date(r[11]):null;
        const delay=r[12]||0;
        history.push({
          jobNo:r[0],productType:r[1],customer:r[2],seq:r[3],processName:r[4],
          durHrs:r[7],planStart:fmtDT(new Date(r[8])),planEnd:fmtDT(pE),
          actStart:r[10]?fmtDT(new Date(r[10])):'',actEnd:aE?fmtDT(aE):'',
          delayHrs:delay,isDelayed:delay>0,status:r[13],assignStatus:a.assignStatus
        });
        break;
      }
    }
  }
  history.sort((a,b)=>{
    if(a.status==='In Progress'&&b.status!=='In Progress') return -1;
    if(b.status==='In Progress'&&a.status!=='In Progress') return 1;
    return new Date(b.planStart)-new Date(a.planStart);
  });
  return {success:true,history,total:history.length,
          completed:history.filter(h=>h.status==='Done').length,
          delayed:history.filter(h=>h.isDelayed).length,
          ongoing:history.filter(h=>h.status==='In Progress').length};
}

// ══════════════════════════════════════════
// DELETE JOB
// ══════════════════════════════════════════

function apiDeleteJob(b) {
  const {jobNo} = b;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (const shName of [SH_JOBS,SH_SCHEDULE,SH_ASSIGNMENTS,SH_INSPECTIONS]) {
    const sh=ss.getSheetByName(shName);
    const data=sh.getDataRange().getValues();
    for (let i=data.length-1;i>=1;i--) {
      if (String(data[i][0])===String(jobNo)||data[i][1]===jobNo) sh.deleteRow(i+1);
    }
  }
  return {success:true,message:'Job '+jobNo+' deleted'};
}

// ══════════════════════════════════════════
// DEPARTMENTS
// ══════════════════════════════════════════

function apiGetDepts() {
  return withBoardCache('depts', 300, function(){ return _apiGetDepts(); }); // rarely changes — long TTL, no writer to invalidate it
}
function _apiGetDepts() {
  const data = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(SH_DEPTS).getDataRange().getValues();
  const depts=[];
  for(let i=1;i<data.length;i++) if(data[i][2]==='YES') depts.push({name:data[i][0],nameGu:data[i][1]});
  return {success:true,depts};
}

// ══════════════════════════════════════════
// COLOR SCHEDULE SHEET
// ══════════════════════════════════════════

function getStatusText(row, now, todayStart, todayEnd, assignedKeys) {
  const planStart=new Date(row[8]), planEnd=new Date(row[9]);
  const actEnd=row[11]?new Date(row[11]):null;
  const status=row[13];
  const key=row[0]+'|'+row[3];
  const isAssigned=assignedKeys&&assignedKeys.has(key);
  if (status==='Done') return actEnd&&actEnd>planEnd?'Completed — Delayed':'Completed — On Time';
  if (status==='Pending Inspection') return 'Completed — Pending Inspection';
  if (status==='Rework') return 'Inspection — Rejected';
  if (status==='In Progress') return now>planEnd?'Running — Delayed':'In Progress — On Time';
  if (planStart<todayStart) return isAssigned?'Overdue — Assigned':'Overdue — Unassigned';
  if (planStart>=todayStart&&planStart<=todayEnd) return isAssigned?'Due Today — Assigned':'Due Today — Unassigned';
  return 'Not Started';
}

function colorScheduleSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_SCHEDULE);
  const data = sh.getDataRange().getValues();
  if (data.length<=1) return;
  const assignData = ss.getSheetByName(SH_ASSIGNMENTS).getDataRange().getValues();
  const assignedKeys=new Set();
  for (let i=1;i<assignData.length;i++) {
    if (assignData[i][7]==='Active') assignedKeys.add(assignData[i][1]+'|'+assignData[i][2]);
  }
  const now=new Date(), todayStart=new Date(), todayEnd=new Date();
  todayStart.setHours(0,0,0,0); todayEnd.setHours(23,59,59,999);
  const numRows=data.length-1, numCols=16;
  const bgColors=[], fgColors=[], statusTexts=[];
  for (let i=1;i<data.length;i++) {
    if (!data[i][0]) {
      bgColors.push(Array(numCols).fill('#ffffff'));
      fgColors.push(Array(numCols).fill('#000000'));
      statusTexts.push(['']); continue;
    }
    const stText=getStatusText(data[i],now,todayStart,todayEnd,assignedKeys);
    const colors=STATUS_COLORS[stText]||{bg:'#ffffff',fg:'#000000'};
    if (stText==='Not Started'||stText==='Not Yet Due') {
      bgColors.push(Array(numCols).fill('#ffffff'));
      fgColors.push(Array(numCols).fill('#374151'));
    } else {
      bgColors.push(Array(numCols).fill(colors.bg));
      fgColors.push(Array(numCols).fill('#000000'));
    }
    statusTexts.push([stText]);
  }
  sh.getRange(2,1,numRows,numCols).setBackgrounds(bgColors);
  sh.getRange(2,1,numRows,numCols).setFontColors(fgColors);
  sh.getRange(2,15,numRows,1).setValues(statusTexts);
  sh.getRange(2,1,numRows,numCols).setFontWeight('normal');
  sh.getRange(2,15,numRows,1).setFontWeight('bold');

  for (let i=1;i<data.length;i++) {
    if (!data[i][0]) continue;
    const durStd = parseFloat(data[i][7])||0;
    const actStart = data[i][10] ? new Date(data[i][10]) : null;
    const actEnd   = data[i][11] ? new Date(data[i][11]) : null;
    if (durStd>0 && actStart && actEnd) {
      const durAct = (actEnd-actStart)/3600000;
      const planStart2 = data[i][8] ? new Date(data[i][8]) : null;
      const isBulk = planStart2 && Math.abs(actStart-planStart2) < 60000;
      if (durAct > durStd && data[i][13]==='Done' && !isBulk) {
        sh.getRange(i+1,13).setBackground('#fed7aa').setFontColor('#000000');
      }
    }
  }
}

function colorScheduleRow(jobNo, seq, ss) {
  const sh = ss.getSheetByName(SH_SCHEDULE);
  const data = sh.getDataRange().getValues();
  const now = new Date();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
  for (let i=1;i<data.length;i++) {
    if (String(data[i][0])===String(jobNo) && data[i][3]==seq) {
      const stText = getStatusText(data[i], now, todayStart, todayEnd, null);
      const colors = STATUS_COLORS[stText]||{bg:'#ffffff',fg:'#000000'};
      sh.getRange(i+1,15).setValue(stText).setFontWeight('bold');
      sh.getRange(i+1,1,1,15).setBackground(colors.bg).setFontColor('#000000');
    }
  }
}

function refreshScheduleColors() { colorScheduleSheet(); }

// ══════════════════════════════════════════
// ADMIN STOP — No auto-assign after stop
// ══════════════════════════════════════════

function apiAdminStop(b) {
  const {jobNo, seq, actEndTime, adminEmail, remark, excessReason} = b;
  if (!jobNo||!seq||!actEndTime) throw new Error('Missing fields');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_SCHEDULE);
  const data = sh.getDataRange().getValues();
  const customEnd = new Date(actEndTime);
  for (let i=1;i<data.length;i++) {
    if (String(data[i][0])!==String(jobNo)||String(data[i][3])!==String(seq)) continue;
    if (data[i][13]!=='In Progress') return {success:false, error:'Process not In Progress'};
    const pE = new Date(data[i][9]);
    const delay = calcWorkingHrsDelay(pE, customEnd);
    sh.getRange(i+1,12).setValue(customEnd);
    sh.getRange(i+1,13).setValue(delay);
    sh.getRange(i+1,14).setValue('Pending Inspection');
    sh.getRange(i+1,15).setValue('Completed — Pending Inspection');
    sh.getRange(i+1,1,1,16).setBackground('#fde68a').setFontColor('#000000');
    const autoRemark = 'Stopped by Admin ('+(adminEmail||'Admin')+') — '+(remark||'')+(excessReason?' | Excess: '+excessReason:'');
    const existing = data[i][15]||'';
    sh.getRange(i+1,16).setValue(existing ? existing+'\n'+autoRemark : autoRemark);
    const procName = data[i][4];
    const workerName = data[i][5]||'Worker';
    const isInspProc = procName==='INSPECTION';
    if (!isInspProc) {
      const inspId = 'I'+Date.now().toString(36).toUpperCase();
      try {
        const inspSh = ss.getSheetByName(SH_INSPECTIONS);
        inspSh.appendRow([inspId,jobNo,seq,procName,workerName,customEnd,'','Pending',autoRemark,'']);
        const assignSh = ss.getSheetByName(SH_ASSIGNMENTS);
        const assignData = assignSh.getDataRange().getValues();
        for (let j=1;j<assignData.length;j++) {
          if (String(assignData[j][1])===String(jobNo)&&String(assignData[j][2])===String(seq)&&assignData[j][7]==='Active')
            assignSh.getRange(j+1,8).setValue('Awaiting Inspection');
        }
      } catch (writeErr) {
        // Compensate: revert the schedule row back to In Progress instead of
        // leaving it stuck as "Pending Inspection" with no inspection record.
        sh.getRange(i+1,12).setValue(data[i][11]||'');
        sh.getRange(i+1,13).setValue(data[i][12]||'');
        sh.getRange(i+1,14).setValue('In Progress');
        sh.getRange(i+1,15).setValue(data[i][14]||'In Progress — On Time');
        sh.getRange(i+1,16).setValue(data[i][15]||'');
        sh.getRange(i+1,1,1,16).setBackground('#fdba74').setFontColor('#000000');
        throw new Error('Could not record inspection — process reverted to In Progress. Please try Stop again. ('+writeErr.message+')');
      }

      // Notify BOTH inspectors
      try {
        GmailApp.sendEmail(NOTIFY_EMAIL,
          'Inspection Required — Job '+jobNo+' Seq '+seq+' (Admin Stop)',
          'Job: '+jobNo+'\nProcess: '+procName+'\nStopped by: '+(adminEmail||'Admin')+
          '\nEnd: '+fmtDT(customEnd)+'\nDelay: '+(delay>0?delay+' hrs late':'On time')+
          '\nReason: '+(remark||'')+'\n\nApp: https://vkv-coder.github.io/EPBL-JOB/');
      } catch(e) { Logger.log('Email error: '+e.message); }

      const inspectorMsgs = INSPECTORS.map(insp=>({
        name:insp.name, mobile:insp.mobile,
        message:'Inspect: Job '+jobNo+' Seq '+seq+' '+procName.substring(0,40)+
                ' | Admin Stop | '+fmtDT(customEnd)
      }));

      // ── NO AUTO-ASSIGN ──
      return {success:true, actEnd:fmtDT(customEnd), delayHrs:delay,
              inspectionPending:true, inspId, remark:autoRemark,
              whatsappInspectors: inspectorMsgs};
    } else {
      sh.getRange(i+1,14).setValue('Done');
      // ── NO AUTO-ASSIGN ──
      return {success:true, actEnd:fmtDT(customEnd), delayHrs:delay, nextAssigned:null};
    }
  }
  throw new Error('Process not found or not In Progress');
}

// ══════════════════════════════════════════
// BULK UPDATE
// ══════════════════════════════════════════

function bulkUpdateJob(jobNo, currentSeq) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSh = ss.getSheetByName(SH_SCHEDULE);
  const assignSh = ss.getSheetByName(SH_ASSIGNMENTS);
  const now = new Date();
  jobNo = String(jobNo); currentSeq = parseInt(currentSeq);
  const data = schedSh.getDataRange().getValues();
  let updatedRows = 0;
  for (let i=1;i<data.length;i++) {
    if (String(data[i][0]) !== jobNo) continue;
    const seq = parseInt(data[i][3]);
    const isInsp = data[i][4] === 'INSPECTION';
    if (seq < currentSeq) {
      schedSh.getRange(i+1,11).setValue(new Date(data[i][8]));
      schedSh.getRange(i+1,12).setValue(new Date(data[i][9]));
      schedSh.getRange(i+1,13).setValue(0);
      schedSh.getRange(i+1,14).setValue('Done');
      schedSh.getRange(i+1,15).setValue('Completed — On Time');
      schedSh.getRange(i+1,1,1,16).setBackground('#86efac').setFontColor('#000000');
      updatedRows++;
    } else if (seq === currentSeq) {
      schedSh.getRange(i+1,11).setValue(now);
      schedSh.getRange(i+1,14).setValue('In Progress');
      schedSh.getRange(i+1,15).setValue('In Progress — On Time');
      schedSh.getRange(i+1,1,1,16).setBackground('#fdba74').setFontColor('#000000');
      updatedRows++;
    }
  }
  Logger.log('Job '+jobNo+': '+updatedRows+' rows updated. Current seq: '+currentSeq);
  return 'Job '+jobNo+' updated. Seq 1-'+(currentSeq-1)+' Done. Seq '+currentSeq+' In Progress.';
}

function bulkUpdateAllJobs() {
  const jobList = [
    ['1085', 46],['1087', 23],['1088', 23],['1089', 21],
    ['1090', 52],['1091', 24],['1092', 24],['1093', 4],['1094', 4],['1095', 4],
  ];
  const results = [];
  for (const [jobNo, seq] of jobList) {
    try { results.push(bulkUpdateJob(jobNo, seq)); }
    catch(e) { results.push('ERROR Job '+jobNo+': '+e.message); }
  }
  colorScheduleSheet();
  SpreadsheetApp.getUi().alert('Bulk Update Complete!\n\n'+results.join('\n'));
}

// ══════════════════════════════════════════
// SUMMARY
// ══════════════════════════════════════════

function createSummaryRow(jobNo, productType, customerName, sched, ss) {
  try {
    const sumSh = ss.getSheetByName(SH_SUMMARY);
    if (!sumSh) return;
    const procs = sched.filter(p => !p.isInsp);
    const standardHrs = procs.reduce((t,p) => t + (parseFloat(p.dur)||0), 0);
    const planStart = sched[0] ? sched[0].pS : new Date();
    const planEnd   = sched[sched.length-1] ? sched[sched.length-1].pE : new Date();
    const data = sumSh.getDataRange().getValues();
    for (let i=1;i<data.length;i++) {
      if (String(data[i][0])===String(jobNo)) {
        sumSh.getRange(i+1,1,1,12).setValues([[jobNo,productType,customerName,
          planStart,planEnd,'','',Math.round(standardHrs*10)/10,'','','','In Progress']]);
        sumSh.getRange(i+1,4,1,2).setNumberFormat('dd/mm/yyyy');
        return;
      }
    }
    sumSh.appendRow([jobNo,productType,customerName,planStart,planEnd,'','',
      Math.round(standardHrs*10)/10,'','','','In Progress']);
    const lastRow = sumSh.getLastRow();
    sumSh.getRange(lastRow,4,1,2).setNumberFormat('dd/mm/yyyy');
    sumSh.getRange(lastRow,8).setNumberFormat('0.0');
  } catch(e) { Logger.log('Summary error: '+e.message); }
}

function updateSummaryOnComplete(jobNo, ss) {
  try {
    const schedSh=ss.getSheetByName(SH_SCHEDULE), sumSh=ss.getSheetByName(SH_SUMMARY);
    if (!sumSh) return;
    const jobRows=schedSh.getDataRange().getValues().filter(r=>String(r[0])===String(jobNo));
    if (!jobRows.length||!jobRows.every(r=>r[13]==='Done')) return;
    let actStartDt=null,actEndDt=null,delayHrs=0;
    for (const r of jobRows) {
      if (r[10]){const aS=new Date(r[10]);if(!actStartDt||aS<actStartDt)actStartDt=aS;}
      if (r[11]){const aE=new Date(r[11]);if(!actEndDt||aE>actEndDt)actEndDt=aE;}
      if (r[12]) delayHrs+=parseFloat(r[12])||0;
    }
    // ActualHrs = sum of all individual seq durations (ActEnd - ActStart per seq)
    let actHrs = 0;
    for (const r of jobRows) {
      if (r[10] && r[11] && r[4]!=='INSPECTION') {
        actHrs += (new Date(r[11]) - new Date(r[10])) / 3600000;
      }
    }
    actHrs = Math.round(actHrs * 10) / 10;
    const calDays=actStartDt&&actEndDt?Math.ceil((actEndDt-actStartDt)/(1000*60*60*24)):0;
    const status=delayHrs>0?'Completed — Delayed':'Completed — On Time';
    const sumData=sumSh.getDataRange().getValues();
    for (let i=1;i<sumData.length;i++) {
      if (sumData[i][0]===jobNo) {
        if(actStartDt) sumSh.getRange(i+1,6).setValue(actStartDt);
        if(actEndDt) sumSh.getRange(i+1,7).setValue(actEndDt);
        sumSh.getRange(i+1,9).setValue(Math.round(actHrs*10)/10);
        sumSh.getRange(i+1,10).setValue(calDays);
        sumSh.getRange(i+1,11).setValue(Math.round(delayHrs*10)/10);
        sumSh.getRange(i+1,12).setValue(status);
        sumSh.getRange(i+1,1,1,12).setBackground(delayHrs>0?'#fca5a5':'#86efac');
        return;
      }
    }
  } catch(e) { Logger.log('Summary complete error: '+e.message); }
}

function apiGetSummary(b) {
  return withBoardCache('summary_board', BOARD_CACHE_TTL, function(){ return _apiGetSummary(b); });
}
function _apiGetSummary(b) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sumSh = ss.getSheetByName(SH_SUMMARY);
    if (!sumSh) return {success:true,rows:[]};
    const assignData = ss.getSheetByName(SH_ASSIGNMENTS).getDataRange().getValues();
    const schedData  = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
    const now = new Date();

    const activeSeqsMap = {};
    const seqActiveMap = {};
    for (let i=1;i<assignData.length;i++) {
      if (assignData[i][7]!=='Active'&&assignData[i][7]!=='Awaiting Inspection') continue;
      const jNo = String(assignData[i][1]);
      const seq = parseInt(assignData[i][2]);
      const isManual = assignData[i][9]==='Y';
      if (!activeSeqsMap[jNo]) activeSeqsMap[jNo]=[];
      if (!activeSeqsMap[jNo].find(x=>x.seq===seq)) {
        activeSeqsMap[jNo].push({seq, isManual});
      }
      if (!isManual) {
        if (!seqActiveMap[jNo]||seq>seqActiveMap[jNo]) seqActiveMap[jNo]=seq;
      }
    }

    const schedMap = {};
    const doneProcCount = {};
    const lowestSeqInSched = {};
    for (let i=1;i<schedData.length;i++) {
      const r=schedData[i]; if(!r[0]) continue;
      const jNo=String(r[0]), seq=parseInt(r[3]);
      const key=jNo+'|'+seq;
      schedMap[key]={
        procName:r[4], planStart:r[8]?new Date(r[8]):null,
        planEnd:r[9]?new Date(r[9]):null, status:r[13],
        isInsp:r[4]==='INSPECTION'
      };
      if (!lowestSeqInSched[jNo]||seq<lowestSeqInSched[jNo]) lowestSeqInSched[jNo]=seq;
      if (r[13]==='Done' && r[4]!=='INSPECTION') {
        if (!doneProcCount[jNo]) doneProcCount[jNo]=0;
        doneProcCount[jNo]++;
      }
    }

    const activeProcMap = {};
    for (const [jNo, seqs] of Object.entries(activeSeqsMap)) {
      activeProcMap[jNo] = seqs.map(s => {
        const info = schedMap[jNo+'|'+s.seq]||{};
        return {seq:s.seq, procName:info.procName||'', isManual:s.isManual,
                planStart:info.planStart, planEnd:info.planEnd};
      }).filter(s=>s.procName!=='INSPECTION').sort((a,b)=>a.seq-b.seq);
    }

    const activePlanMap = {};
    for (let i=1;i<schedData.length;i++) {
      const r=schedData[i]; if(!r[0]) continue;
      const jNo=String(r[0]), seq=parseInt(r[3]);
      if (seqActiveMap[jNo]&&seq===seqActiveMap[jNo]) {
        activePlanMap[jNo]={planStart:r[8]?new Date(r[8]):null,planEnd:r[9]?new Date(r[9]):null,procName:r[4]};
      }
    }

    const data = sumSh.getDataRange().getValues();
    const rows = [];
    for (let i=1;i<data.length;i++) {
      if (!data[i][0]) continue;
      const jNo = String(data[i][0]);
      const productType = data[i][1];
      // ── doneCount and totalWorkProcs — INSPECTION rows excluded ──
      // Total work procs = non-INSPECTION rows in Schedule for this job
      const totalWorkProcs = schedData.slice(1).filter(r=>
        String(r[0])===jNo && r[4]!=='INSPECTION'
      ).length;
      // Done count = Done non-INSPECTION rows (already counted in doneProcCount)
      const doneCount = doneProcCount[jNo]||0;
      const currentSeq = seqActiveMap[jNo]||0;
      const activeProcs = activeProcMap[jNo]||[];
      let delayDays=0, delayStatus='On Time', delayText='✓ On Time';
      const jobPlannedStart = data[i][3]?new Date(data[i][3]):null;
      const jobActualStart  = data[i][5]?new Date(data[i][5]):null;
      const activePlan = activePlanMap[jNo];
      let startDelayDays = 0, startDelayText = '';
      if (jobActualStart && jobPlannedStart) {
        startDelayDays = Math.floor((jobActualStart-jobPlannedStart)/(1000*60*60*24));
        if (startDelayDays>0) startDelayText = 'Started '+startDelayDays+' day'+(startDelayDays>1?'s':'')+' late';
        else if (startDelayDays<0) startDelayText = 'Started '+Math.abs(startDelayDays)+' day'+(Math.abs(startDelayDays)>1?'s':'')+' early';
      }
      if (!jobActualStart && jobPlannedStart) {
        delayDays = Math.floor((now-jobPlannedStart)/(1000*60*60*24));
        if (delayDays>0) { delayStatus='Delayed'; delayText=delayDays+' day'+(delayDays>1?'s':'')+' late'; }
        else if (delayDays<0) { delayStatus='Early'; delayText=Math.abs(delayDays)+' day'+(Math.abs(delayDays)>1?'s':'')+' early'; }
      } else if (jobActualStart && activePlan && activePlan.planStart) {
        delayDays = Math.floor((now-activePlan.planStart)/(1000*60*60*24));
        if (delayDays>0) { delayStatus='Delayed'; delayText=delayDays+' day'+(delayDays>1?'s':'')+' late'; }
        else if (delayDays<0) { delayStatus='Early'; delayText=Math.abs(delayDays)+' day'+(Math.abs(delayDays)>1?'s':'')+' early'; }
      }
      let actualStartDt = data[i][5] ? new Date(data[i][5]) : null;
      if (!actualStartDt) {
        for (let j=1;j<schedData.length;j++) {
          if (String(schedData[j][0])===jNo && schedData[j][10]) {
            const aS = new Date(schedData[j][10]);
            if (!actualStartDt || aS < actualStartDt) actualStartDt = aS;
          }
        }
        if (actualStartDt) sumSh.getRange(i+1,6).setValue(actualStartDt);
      }
      rows.push({
        jobNo:data[i][0], productType, customer:data[i][2],
        plannedStart:data[i][3]?fmtD(new Date(data[i][3])):'',
        plannedEnd:data[i][4]?fmtD(new Date(data[i][4])):'',
        actualStart:actualStartDt?fmtD(actualStartDt):'',
        actualEnd:data[i][6]?fmtD(new Date(data[i][6])):'',
        standardHrs:data[i][7]||0, actualHrs:data[i][8]||0,
        calendarDays:data[i][9]||0, delayHrs:data[i][10]||0,
        status:data[i][11]||'In Progress',
        currentSeq, totalWorkProcs, doneCount,
        activeProcs, startDelayText,
        delayDays, delayStatus, delayText
      });
    }
    return {success:true,rows};
  } catch(e) { return {success:false,error:e.message}; }
}

// ══════════════════════════════════════════
// CLEANUP
// ══════════════════════════════════════════

function cleanDuplicateScheduleRows() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_SCHEDULE);
  const data = sh.getDataRange().getValues();
  const priority = {'Done':5, 'Pending Inspection':4, 'Rework':3, 'In Progress':2, 'Pending':1};
  const groups = {};
  for (let i=1;i<data.length;i++) {
    if (!data[i][0]) continue;
    const key = String(data[i][0])+'|'+String(data[i][3]);
    if (!groups[key]) groups[key] = [];
    groups[key].push({rowIndex:i+1, row:data[i]});
  }
  const rowsToDelete = [];
  let duplicateCount = 0;
  for (const key of Object.keys(groups)) {
    const group = groups[key];
    if (group.length <= 1) continue;
    group.sort((a,b) => {
      const pa = priority[a.row[13]] || 0;
      const pb = priority[b.row[13]] || 0;
      if (pb !== pa) return pb - pa;
      const hasActA = a.row[10] ? 1 : 0;
      const hasActB = b.row[10] ? 1 : 0;
      return hasActB - hasActA;
    });
    for (let i=1;i<group.length;i++) {
      rowsToDelete.push(group[i].rowIndex);
      duplicateCount++;
    }
  }
  rowsToDelete.sort((a,b) => b-a);
  for (const rowIdx of rowsToDelete) sh.deleteRow(rowIdx);
  colorScheduleSheet();
  SpreadsheetApp.getUi().alert('✅ Cleanup Complete!\nDuplicate rows deleted: '+duplicateCount);
}

// ══════════════════════════════════════════
// TRIGGERS — AUTO-ASSIGN DISABLED
// runAutoAssignAll is a no-op (kept so existing triggers don't error)
// syncAssignmentsFromSchedule only syncs Done status, no assignment
// ══════════════════════════════════════════

function syncAssignmentsFromSchedule() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const assignSh  = ss.getSheetByName(SH_ASSIGNMENTS);
  const assignData = assignSh.getDataRange().getValues();
  const schedData  = ss.getSheetByName(SH_SCHEDULE).getDataRange().getValues();
  const schedMap = {};
  for (let i=1;i<schedData.length;i++) {
    const key = String(schedData[i][0])+'|'+String(schedData[i][3]);
    schedMap[key] = schedData[i][13];
  }
  let fixed = 0;
  for (let i=1;i<assignData.length;i++) {
    if (assignData[i][7]!=='Active') continue;
    const key = String(assignData[i][1])+'|'+String(assignData[i][2]);
    const schedStatus = schedMap[key];
    if (schedStatus==='Done' || schedStatus==='Pending Inspection') {
      assignSh.getRange(i+1,8).setValue('Completed');
      fixed++;
    }
  }
  Logger.log('✅ Assignments synced. Rows marked Completed: '+fixed);
}

// No-op — auto-assign is disabled. Kept so any existing trigger does not error out.
function runAutoAssignAll() {
  Logger.log('runAutoAssignAll: AUTO-ASSIGN IS DISABLED. Admin assigns manually.');
}

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════

function fmtD(d) {
  if(!d) return ''; const x=new Date(d);
  return x.getDate().toString().padStart(2,'0')+'/'+(x.getMonth()+1).toString().padStart(2,'0')+'/'+x.getFullYear();
}
function fmtDT(d) {
  if(!d) return ''; const x=new Date(d);
  return fmtD(x)+' '+x.getHours().toString().padStart(2,'0')+':'+x.getMinutes().toString().padStart(2,'0');
}

function findOrCreateWorker(name, mobile, ss) {
  if (!name||!mobile) return null;
  const sh = ss.getSheetByName(SH_WORKERS);
  const data = sh.getDataRange().getValues();
  for (let i=1;i<data.length;i++) {
    if (data[i][1]===name || data[i][2]===mobile) return data[i][0];
  }
  return null; // Do NOT auto-create workers anymore
}

function getJobType(jobNo, ss) {
  const data = ss.getSheetByName(SH_JOBS).getDataRange().getValues();
  for (let i=1;i<data.length;i++) {
    if (String(data[i][0])===String(jobNo)) return data[i][1];
  }
  return null;
}

// Placeholder — kept for any legacy calls but does nothing
function apiGetDeptJobs(b) {
  return {success:true, jobs:[]};
}

// ══════════════════════════════════════════
// ONE-TIME FIX — Rebuild missing Schedule work rows
// Run once from Apps Script editor: rebuildScheduleWorkRows()
// Fixes jobs: 1085, 1088, 1090, 1091, 1092, 1093
// Rebuilds all work process rows from Master sheet
// Marks all as Done, ActStart=PlanStart, ActEnd=PlanEnd, Delay=0
// Leaves INSPECTION rows untouched
// ══════════════════════════════════════════

function rebuildScheduleWorkRows() {
  // ── BATCH VERSION — all writes in one setValues call ──
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSh = ss.getSheetByName(SH_SCHEDULE);

  // Change jobNo and info below for each job, run once per job
  const jobNo = '1085';
  const info  = {productType:'Autoclave', customerName:'Palm technocast', startDate:'2026-03-27'};
  // Other jobs — change above values one at a time:
  // 1088 · Autoclave · Palm technocast      · 2026-03-14
  // 1090 · Autoclave · Agency technost      · 2026-02-09
  // 1091 · Autoclave · Dwarkesh eng works   · 2026-02-24
  // 1092 · Autoclave · (customer name)      · 2026-02-27
  // 1093 · Autoclave · (customer name)      · 2026-04-13

  const procs = getMasterFromSheet(info.productType, ss);
  if (!procs || !procs.length) {
    SpreadsheetApp.getUi().alert('❌ No master data for ' + info.productType);
    return;
  }

  // Read existing seqs for this job
  const schedData = schedSh.getDataRange().getValues();
  const existingSeqs = new Set();
  for (let i = 1; i < schedData.length; i++) {
    if (String(schedData[i][0]) === String(jobNo)) {
      existingSeqs.add(parseInt(schedData[i][3]));
    }
  }

  // Read assignment statuses for this job
  const assignData2 = ss.getSheetByName(SH_ASSIGNMENTS).getDataRange().getValues();
  const assignedSeqs = {};
  const priority = {'Completed':3,'Awaiting Inspection':2,'Active':1};
  for (let i = 1; i < assignData2.length; i++) {
    if (String(assignData2[i][1]) !== String(jobNo)) continue;
    const seq = parseInt(assignData2[i][2]);
    const st  = assignData2[i][7];
    if (!assignedSeqs[seq] || (priority[st]||0) > (priority[assignedSeqs[seq]]||0)) {
      assignedSeqs[seq] = st;
    }
  }

  // Build all rows in memory — NO date calculation, use dummy dates
  // Planned dates not needed for historical completed jobs
  const startDt = new Date(info.startDate);
  const newRows = [];

  for (const p of procs) {
    if (existingSeqs.has(p.seq)) continue;
    if (p.isInsp) continue;

    const assignStatus = assignedSeqs[p.seq] || 'Pending';
    const isDone     = assignStatus === 'Completed';
    const isProgress = assignStatus === 'Active' || assignStatus === 'Awaiting Inspection';
    const status     = isDone ? 'Done' : isProgress ? 'In Progress' : 'Pending';
    const statusText = isDone ? 'Completed — On Time' : isProgress ? 'In Progress — On Time' : 'Not Started';

    newRows.push([
      jobNo, info.productType, info.customerName,
      p.seq, p.name, p.worker, "'"+String(p.mobile),
      Number(p.dur), startDt, startDt,
      (isDone||isProgress) ? startDt : '',
      isDone ? startDt : '',
      0, status, statusText, ''
    ]);
  }

  if (!newRows.length) {
    SpreadsheetApp.getUi().alert('✅ No new rows needed for ' + jobNo + ' — already complete!');
    return;
  }

  // ── BATCH WRITE — one single call ──
  const lastRow = schedSh.getLastRow();
  schedSh.getRange(lastRow + 1, 1, newRows.length, 16).setValues(newRows);

  SpreadsheetApp.getUi().alert(
    '✅ Done! ' + newRows.length + ' rows added for Job ' + jobNo +
    '\n\nNext: change jobNo in function and run again for next job.' +
    '\n\nThen use Refresh Colors button in app.'
  );
}

// ══════════════════════════════════════════
// ONE-TIME FIX — Mark INSPECTION rows Done
// for jobs where all work seqs are Done
// Run once: fixInspectionRowsForCompletedJobs()
// ══════════════════════════════════════════

function fixInspectionRowsForCompletedJobs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_SCHEDULE);
  const data = sh.getDataRange().getValues();

  // Find jobs where ALL non-inspection rows are Done
  const jobWorkStatus = {}; // jobNo -> {total, done}
  for (let i = 1; i < data.length; i++) {
    const r = data[i]; if (!r[0]) continue;
    const jNo = String(r[0]);
    if (r[4] === 'INSPECTION') continue; // skip inspection
    if (!jobWorkStatus[jNo]) jobWorkStatus[jNo] = {total:0, done:0};
    jobWorkStatus[jNo].total++;
    if (r[13] === 'Done') jobWorkStatus[jNo].done++;
  }

  // Jobs where all work seqs are Done
  const completedJobs = new Set();
  for (const [jNo, st] of Object.entries(jobWorkStatus)) {
    if (st.total > 0 && st.total === st.done) completedJobs.add(jNo);
  }

  // Mark all INSPECTION rows as Done for completed jobs
  let fixed = 0;
  for (let i = 1; i < data.length; i++) {
    const r = data[i]; if (!r[0]) continue;
    if (r[4] !== 'INSPECTION') continue;
    if (!completedJobs.has(String(r[0]))) continue;
    if (r[13] === 'Done') continue; // already done
    sh.getRange(i+1, 14).setValue('Done');
    sh.getRange(i+1, 15).setValue('Completed — On Time');
    sh.getRange(i+1, 1, 1, 15).setBackground('#86efac').setFontColor('#000000');
    fixed++;
  }

  SpreadsheetApp.getUi().alert(
    '✅ Done!\n\n' +
    'Completed jobs found: ' + completedJobs.size + '\n' +
    'Jobs: ' + [...completedJobs].join(', ') + '\n\n' +
    'INSPECTION rows marked Done: ' + fixed
  );
}

// ══════════════════════════════════════════
// ONE-TIME FIX — Backfill blank ActStart/ActEnd
// on existing INSPECTION rows (historical data —
// these rows were never Start/Stop-able so old
// approvals left them blank). Uses the ActEnd of
// the nearest earlier work seq in the same job as
// both ActStart and ActEnd for the inspection row.
// Run once: fixInspectionActualTimestamps()
// ══════════════════════════════════════════

function fixInspectionActualTimestamps() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_SCHEDULE);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) { SpreadsheetApp.getUi().alert('No data rows.'); return; }

  const fullRange = sh.getRange(2, 1, lastRow - 1, 15); // A:O, header excluded
  const data = fullRange.getValues();          // 1 API call — values only, fast even for huge sheets

  // Group row indices by job, sorted by seq, to find "nearest earlier work row"
  // and to check whether all WORK (non-inspection) seqs for the job are Done.
  const byJob = {};
  for (let i = 0; i < data.length; i++) {
    const r = data[i]; if (!r[0]) continue;
    const jNo = String(r[0]);
    if (!byJob[jNo]) byJob[jNo] = [];
    byJob[jNo].push({row:i, seq:parseInt(r[3]), isInsp:r[4]==='INSPECTION',
                      actEnd:r[11]||null, planEnd:r[9]||null, status:r[13]});
  }

  const fixedRows = []; // {row, colors} — only these get a color pass, not the whole sheet
  let skipped = 0;
  for (const jNo in byJob) {
    const rows = byJob[jNo].sort((a,b)=>a.seq-b.seq);
    const workRows = rows.filter(rr=>!rr.isInsp);
    const jobWorkDone = workRows.length>0 && workRows.every(rr=>rr.status==='Done');

    for (let k = 0; k < rows.length; k++) {
      const rr = rows[k];
      if (!rr.isInsp) continue;
      if (data[rr.row][10] && data[rr.row][11]) continue; // already has both stamps
      if (!jobWorkDone) { skipped++; continue; } // job's own work isn't finished yet — leave Pending

      // nearest earlier row (any type) that has an ActEnd
      let stampSrc = null;
      for (let p = k-1; p >= 0; p--) {
        if (rows[p].actEnd) { stampSrc = rows[p].actEnd; break; }
      }
      if (!stampSrc) { skipped++; continue; } // nothing to backfill from

      const stampDt = new Date(stampSrc);
      const planEndDt = rr.planEnd ? new Date(rr.planEnd) : stampDt;
      const delay = calcWorkingHrsDelay(planEndDt, stampDt);
      const stText = delay > 0 ? 'Completed — Delayed' : 'Completed — On Time';

      data[rr.row][10] = stampDt;
      data[rr.row][11] = stampDt;
      data[rr.row][12] = delay;
      data[rr.row][13] = 'Done';
      data[rr.row][14] = stText;
      fixedRows.push({row:rr.row, colors:STATUS_COLORS[stText]});
    }
  }

  if (fixedRows.length > 0) {
    fullRange.setValues(data); // 1 API call — whole sheet, values only

    // Recolor only the rows that actually changed (not the whole sheet —
    // getBackgrounds/setBackgrounds over thousands of rows is what made
    // the earlier version take minutes).
    for (const fr of fixedRows) {
      sh.getRange(fr.row+2, 1, 1, 15).setBackground(fr.colors.bg).setFontColor('#000000');
    }
    SpreadsheetApp.flush();
  }

  Logger.log('INSPECTION rows fixed (Done + timestamps): ' + fixedRows.length +
             ' | Skipped (job not fully done yet, or no earlier timestamp to copy): ' + skipped);
}

// ══════════════════════════════════════════
// ONE-TIME FIX — Force-complete specific jobs
// Marks EVERY row (work + INSPECTION) for the listed
// jobs as Done, fills ActStart/ActEnd if blank, Delay=0,
// colors green, and updates Summary sheet
// (ActualEnd = today, Status = Completed — On Time)
// Run once: forceCompleteJobs()
// ══════════════════════════════════════════

function forceCompleteJobs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSh = ss.getSheetByName(SH_SCHEDULE);
  const sumSh = ss.getSheetByName(SH_SUMMARY);
  const data = schedSh.getDataRange().getValues();
  const now = new Date();

  const jobsToComplete = ['1085','1088','1090','1091','1092','1093'];
  const jobSet = new Set(jobsToComplete);

  let rowsFixed = 0;
  for (let i=1;i<data.length;i++) {
    const r = data[i]; if (!r[0]) continue;
    if (!jobSet.has(String(r[0]))) continue;
    if (r[13]==='Done') continue; // already done, skip

    const planStart = r[8] ? new Date(r[8]) : now;
    const planEnd   = r[9] ? new Date(r[9]) : now;
    const actStart  = r[10] ? new Date(r[10]) : planStart;
    const actEnd    = r[11] ? new Date(r[11]) : planEnd;

    schedSh.getRange(i+1,11).setValue(actStart);
    schedSh.getRange(i+1,12).setValue(actEnd);
    schedSh.getRange(i+1,13).setValue(0);
    schedSh.getRange(i+1,14).setValue('Done');
    schedSh.getRange(i+1,15).setValue('Completed — On Time');
    schedSh.getRange(i+1,1,1,15).setBackground('#86efac').setFontColor('#000000');
    rowsFixed++;
  }

  // Update Summary sheet for each job
  let summaryFixed = 0;
  if (sumSh) {
    const sumData = sumSh.getDataRange().getValues();
    for (const jobNo of jobsToComplete) {
      for (let i=1;i<sumData.length;i++) {
        if (String(sumData[i][0])===String(jobNo)) {
          sumSh.getRange(i+1,7).setValue(now); // ActualEnd
          sumSh.getRange(i+1,11).setValue(0);  // DelayHrs
          sumSh.getRange(i+1,12).setValue('Completed — On Time'); // Status
          sumSh.getRange(i+1,1,1,12).setBackground('#86efac').setFontColor('#000000');
          summaryFixed++;
          break;
        }
      }
    }
  }

  colorScheduleSheet();

  SpreadsheetApp.getUi().alert(
    '✅ Force Complete Done!\n\n' +
    'Jobs: ' + jobsToComplete.join(', ') + '\n' +
    'Schedule rows fixed: ' + rowsFixed + '\n' +
    'Summary rows updated: ' + summaryFixed + '\n\n' +
    'These jobs will now be hidden from All Jobs in the app.'
  );
}

// ══════════════════════════════════════════
// FIND & CLEAN DUPLICATE ACTIVE ASSIGNMENTS
// Run once: cleanDuplicateAssignments()
// Keeps only the LATEST active assignment per Job+Seq
// Marks older duplicates as 'Duplicate-Removed'
// ══════════════════════════════════════════

function cleanDuplicateAssignments() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_ASSIGNMENTS);
  const data = sh.getDataRange().getValues();

  const groups = {};
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r[0]) continue;
    if (r[7] !== 'Active') continue;
    const key = String(r[1]) + '|' + String(r[2]);
    if (!groups[key]) groups[key] = [];
    groups[key].push({
      rowIndex: i + 1,
      assignId: r[0],
      jobNo: r[1],
      seq: r[2],
      workerName: r[5],
      workerId: r[4],
      assignedAt: r[6] ? new Date(r[6]) : new Date(0)
    });
  }

  let duplicateCount = 0;
  const jobsAffected = [];
  const rowsToMark = [];

  for (const [key, rows] of Object.entries(groups)) {
    if (rows.length <= 1) continue;
    rows.sort((a, b) => b.assignedAt - a.assignedAt);
    const keeper = rows[0];
    const toRemove = rows.slice(1);
    jobsAffected.push('Job '+keeper.jobNo+' Seq '+keeper.seq+': '+rows.length+' active → kept '+keeper.workerName+', removed '+toRemove.length);
    for (const r of toRemove) { rowsToMark.push(r.rowIndex); duplicateCount++; }
  }

  for (const rowIdx of rowsToMark) {
    sh.getRange(rowIdx, 8).setValue('Duplicate-Removed');
  }

  if (duplicateCount === 0) {
    Logger.log('✅ No duplicate active assignments found! All clean.');
    return;
  }

  const msg = '✅ Cleanup Complete!\n\nDuplicates removed: ' + duplicateCount + '\n\n' + jobsAffected.join('\n');
  Logger.log(msg);
}

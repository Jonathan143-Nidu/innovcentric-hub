try {
    console.log('Checking Auth...');
    require('./src/auth');
    console.log('Checking AI...');
    require('./src/ai');
    console.log('Checking Workspace...');
    require('./src/workspace');
    console.log('Checking Index...');
    require('./index');
    console.log('ALL FILES SYNTAX OK');
} catch (e) {
    console.error('SYNTAX ERROR DETECTED:');
    console.error(e);
}
